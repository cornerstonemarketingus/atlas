import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { defineTool } from "../../../../../packages/atlas-contracts/src/index.mjs";
import { SkillApprovals, actorKey, openSkillsDatabase, withTransaction } from "./approvals.mjs";
import {
  SkillError,
  compareSemver,
  manifestDigest,
  parseEntry,
  permissionsOutside,
  publicKeyId,
  sha256Hex,
  validateManifest,
  verifyManifestSignature,
  verifyPackageFiles,
} from "./package.mjs";
import { createTerminalTestRunner } from "./test-runner.mjs";
import { matchesPermission } from "../policy.mjs";

/**
 * Tenant-scoped registry of signed skill packages (blueprint §13 B, I).
 *
 * Install is a gate with six locks, checked in this order, each refusal
 * audited:
 *   1. the manifest is well formed;
 *   2. its Ed25519 signature verifies against a key the tenant trusts for
 *      the publisher the manifest names;
 *   3. every shipped file matches the digest the signed manifest pins, and
 *      nothing unpinned is shipped;
 *   4. its permissions sit inside the tenant's permission ceiling, and every
 *      tool it exposes is covered by its own permissions;
 *   5. a human approval exists for exactly this manifest digest;
 *   6. every declared test passes in a sandbox workspace.
 * Only then are the files written to a content-addressed store and the
 * approval consumed, in one transaction with the version row.
 *
 * Code is never loaded from the package the caller handed in. `loadTools`
 * re-checks the stored manifest's signature against the current keyring,
 * reads each entry file from the content-addressed store, re-verifies its
 * digest, and imports exactly the bytes it verified (as a data: URL), so a
 * file edited on disk after install is refused rather than run and there is
 * no window between verifying a file and importing it. The consequence is
 * that entry modules must be self-contained (they may import `node:`
 * builtins, not sibling files).
 *
 * Risk and consequential flags come from the signed manifest, never from the
 * module, so the policy engine sees what the publisher signed.
 */
export class SkillRegistry {
  #db;
  #clock;
  #objects;
  #testRunner;
  approvals;

  constructor({ db = undefined, filename = undefined, storeDirectory, testRunner = undefined, clock = () => new Date(), approvals = undefined }) {
    if (!storeDirectory) throw new SkillError("MISCONFIGURED", "SkillRegistry needs a storeDirectory for its content-addressed store.");
    this.#db = db ?? openSkillsDatabase(filename ?? join(storeDirectory, "skills.sqlite"));
    this.#clock = clock;
    this.#objects = join(storeDirectory, "objects");
    mkdirSync(this.#objects, { recursive: true, mode: 0o700 });
    this.#testRunner = testRunner ?? createTerminalTestRunner({ rootDirectory: join(storeDirectory, "sandbox") });
    this.approvals = approvals ?? new SkillApprovals({ db: this.#db, clock });
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS skill_publishers (
        tenant_id TEXT NOT NULL, publisher TEXT NOT NULL, key_id TEXT NOT NULL, public_key_pem TEXT NOT NULL,
        trusted_by TEXT NOT NULL, trusted_at TEXT NOT NULL, revoked_at TEXT,
        PRIMARY KEY (tenant_id, publisher, key_id)
      );
      CREATE TABLE IF NOT EXISTS skill_ceilings (
        tenant_id TEXT PRIMARY KEY, permissions_json TEXT NOT NULL, set_by TEXT NOT NULL, set_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS skill_versions (
        tenant_id TEXT NOT NULL, name TEXT NOT NULL, version TEXT NOT NULL, publisher TEXT NOT NULL, key_id TEXT NOT NULL,
        manifest_json TEXT NOT NULL, manifest_digest TEXT NOT NULL, signature TEXT NOT NULL,
        approval_id TEXT NOT NULL, installed_by TEXT NOT NULL, test_report_json TEXT NOT NULL,
        installed_at TEXT NOT NULL, uninstalled_at TEXT,
        PRIMARY KEY (tenant_id, name, version)
      );
      CREATE TABLE IF NOT EXISTS skill_active (
        tenant_id TEXT NOT NULL, name TEXT NOT NULL, version TEXT NOT NULL, activated_at TEXT NOT NULL,
        PRIMARY KEY (tenant_id, name)
      );
      CREATE TABLE IF NOT EXISTS skill_audit (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id TEXT NOT NULL, action TEXT NOT NULL, outcome TEXT NOT NULL,
        skill TEXT, version TEXT, actor TEXT, detail_json TEXT NOT NULL, created_at TEXT NOT NULL
      );
    `);
  }

  get db() { return this.#db; }

  close() { this.#db.close(); }

  // ---------------------------------------------------------------------------
  // Keyring and ceiling
  // ---------------------------------------------------------------------------

  trustPublisher(tenantId, { publisher, publicKeyPem, trustedBy }) {
    requireTenant(tenantId);
    let keyId;
    try { keyId = publicKeyId(publicKeyPem); } catch { throw new SkillError("INVALID_KEY", "The publisher key is not a readable public key."); }
    const actor = actorKey(trustedBy);
    this.#db.prepare(
      `INSERT INTO skill_publishers (tenant_id, publisher, key_id, public_key_pem, trusted_by, trusted_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (tenant_id, publisher, key_id) DO UPDATE SET revoked_at = NULL, trusted_by = excluded.trusted_by, trusted_at = excluded.trusted_at`,
    ).run(tenantId, publisher, keyId, publicKeyPem, actor, this.#now());
    this.#audit(tenantId, "publisher.trust", "ok", { actor, detail: { publisher, keyId } });
    return { publisher, keyId };
  }

  revokePublisher(tenantId, { publisher, keyId = undefined, revokedBy }) {
    const actor = actorKey(revokedBy);
    const sql = keyId
      ? "UPDATE skill_publishers SET revoked_at = ? WHERE tenant_id = ? AND publisher = ? AND key_id = ? AND revoked_at IS NULL"
      : "UPDATE skill_publishers SET revoked_at = ? WHERE tenant_id = ? AND publisher = ? AND revoked_at IS NULL";
    const args = keyId ? [this.#now(), tenantId, publisher, keyId] : [this.#now(), tenantId, publisher];
    const changes = Number(this.#db.prepare(sql).run(...args).changes);
    this.#audit(tenantId, "publisher.revoke", "ok", { actor, detail: { publisher, keyId: keyId ?? null, revoked: changes } });
    return { revoked: changes };
  }

  #trustedKeys(tenantId, publisher) {
    return this.#db.prepare("SELECT key_id, public_key_pem FROM skill_publishers WHERE tenant_id = ? AND publisher = ? AND revoked_at IS NULL")
      .all(tenantId, publisher).map((row) => ({ keyId: row.key_id, publicKeyPem: row.public_key_pem }));
  }

  setPermissionCeiling(tenantId, permissions, { setBy }) {
    requireTenant(tenantId);
    if (!Array.isArray(permissions) || permissions.some((p) => typeof p !== "string" || !p)) {
      throw new SkillError("INVALID_INPUT", "A permission ceiling is a list of permission globs.");
    }
    const actor = actorKey(setBy);
    this.#db.prepare(
      `INSERT INTO skill_ceilings (tenant_id, permissions_json, set_by, set_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (tenant_id) DO UPDATE SET permissions_json = excluded.permissions_json, set_by = excluded.set_by, set_at = excluded.set_at`,
    ).run(tenantId, JSON.stringify(permissions), actor, this.#now());
    this.#audit(tenantId, "ceiling.set", "ok", { actor, detail: { permissions } });
    return [...permissions];
  }

  getPermissionCeiling(tenantId) {
    const row = this.#db.prepare("SELECT permissions_json FROM skill_ceilings WHERE tenant_id = ?").get(tenantId);
    return row ? JSON.parse(row.permissions_json) : [];
  }

  // ---------------------------------------------------------------------------
  // Install
  // ---------------------------------------------------------------------------

  /** Asks a human to approve installing exactly this manifest. */
  requestInstallApproval(tenantId, pkg, { requestedBy }) {
    const manifest = validateManifest(pkg?.manifest);
    return this.approvals.request({
      tenantId, kind: "skill.install", subjectDigest: manifestDigest(manifest), requestedBy,
      summary: `${manifest.publisher}/${manifest.name}@${manifest.version}: ${manifest.permissions.join(", ")}`,
    });
  }

  /**
   * Checks everything except tests and approval. Returns
   * `{ manifest, digest, keyId }` or throws SkillError. Used by install and
   * by proposal evaluation.
   */
  verifyPackage(tenantId, pkg) {
    requireTenant(tenantId);
    if (!pkg || typeof pkg !== "object") throw new SkillError("INVALID_PACKAGE", "A skill package is required.");
    const manifest = validateManifest(pkg.manifest);
    const keys = this.#trustedKeys(tenantId, manifest.publisher);
    if (keys.length === 0) throw new SkillError("UNTRUSTED_PUBLISHER", `Publisher '${manifest.publisher}' is not trusted in this tenant.`);
    const keyId = verifyManifestSignature(manifest, pkg.signature, keys);
    if (!keyId) throw new SkillError("BAD_SIGNATURE", "The manifest signature does not verify against any trusted key for its publisher.");
    const fileProblems = verifyPackageFiles(manifest, pkg.files);
    if (fileProblems.length > 0) throw new SkillError("DIGEST_MISMATCH", `Package files do not match the signed manifest: ${fileProblems.join("; ")}.`, fileProblems);
    const outside = permissionsOutside(manifest.permissions, this.getPermissionCeiling(tenantId));
    if (outside.length > 0) {
      throw new SkillError("PERMISSION_ESCALATION", `Permissions exceed this tenant's ceiling: ${outside.join(", ")}.`, outside);
    }
    const uncovered = manifest.tools.filter((tool) => !manifest.permissions.some((glob) => matchesPermission(glob, tool.name)));
    if (uncovered.length > 0) {
      throw new SkillError("PERMISSION_ESCALATION", `Tools outside the skill's declared permissions: ${uncovered.map((t) => t.name).join(", ")}.`);
    }
    return { manifest, digest: manifestDigest(manifest), keyId };
  }

  /** Runs the package's declared tests through the injected runner and insists every one passed. */
  async runPackageTests(tenantId, pkg) {
    let report;
    try {
      report = await this.#testRunner({ tenantId, manifest: pkg.manifest, files: pkg.files });
    } catch (error) {
      return { ok: false, results: [], error: String(error?.message ?? error).slice(0, 500) };
    }
    const results = Array.isArray(report?.results) ? report.results : [];
    const byName = new Map(results.map((r) => [r?.name, r]));
    const missing = pkg.manifest.tests.filter((t) => byName.get(t.name)?.ok !== true).map((t) => t.name);
    return {
      ok: report?.ok === true && missing.length === 0,
      failed: missing,
      results: results.map((r) => ({ name: String(r?.name), ok: r?.ok === true, exitCode: r?.exitCode ?? null, durationMs: r?.durationMs ?? null })),
    };
  }

  async install(pkg, { tenantId, approvalId, approvedBy, installedBy = approvedBy, activate = true } = {}) {
    const label = { skill: pkg?.manifest?.name ?? null, version: pkg?.manifest?.version ?? null };
    try {
      if (!installedBy) throw new SkillError("APPROVAL_REQUIRED", "Installing a skill requires an explicit approver.");
      const { manifest, digest, keyId } = this.verifyPackage(tenantId, pkg);
      if (this.#versionRow(tenantId, manifest.name, manifest.version)) {
        throw new SkillError("ALREADY_INSTALLED", `${manifest.name}@${manifest.version} is already installed; versions are immutable.`);
      }
      const approvalProblem = approvedBy
        ? this.approvals.problem(tenantId, approvalId, { kind: "skill.install", subjectDigest: digest, approvedBy })
        : "no approver was named";
      if (approvalProblem) throw new SkillError("APPROVAL_REQUIRED", `Installing requires human approval: ${approvalProblem}.`);

      const tests = await this.runPackageTests(tenantId, pkg);
      if (!tests.ok) throw new SkillError("TESTS_FAILED", `Declared tests did not pass: ${(tests.failed ?? []).join(", ") || tests.error}.`, tests);

      // Files go to the store before the row that references them; an orphaned object is harmless.
      for (const [path, hash] of Object.entries(manifest.files)) this.#putObject(hash, pkg.files[path]);
      const actor = actorKey(installedBy);
      withTransaction(this.#db, () => {
        if (!this.approvals.consume(tenantId, approvalId)) throw new SkillError("APPROVAL_REQUIRED", "The approval was used concurrently.");
        this.#db.prepare(
          `INSERT INTO skill_versions (tenant_id, name, version, publisher, key_id, manifest_json, manifest_digest, signature,
                                       approval_id, installed_by, test_report_json, installed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(tenantId, manifest.name, manifest.version, manifest.publisher, keyId, JSON.stringify(manifest), digest, pkg.signature,
          approvalId, actor, JSON.stringify(tests), this.#now());
        this.#audit(tenantId, "install", "ok", { ...label, actor, detail: { manifestDigest: digest, keyId, approvalId, tests: tests.results.length } });
      });
      if (activate) this.activate(tenantId, manifest.name, manifest.version, { actor: installedBy });
      return this.getVersion(tenantId, manifest.name, manifest.version);
    } catch (error) {
      if (error instanceof SkillError) {
        this.#audit(tenantId ?? "unknown", "install", "refused", { ...label, actor: safeActor(installedBy), detail: { code: error.code, message: error.message } });
      }
      throw error;
    }
  }

  // ---------------------------------------------------------------------------
  // Versions and activation
  // ---------------------------------------------------------------------------

  #versionRow(tenantId, name, version) {
    return this.#db.prepare("SELECT * FROM skill_versions WHERE tenant_id = ? AND name = ? AND version = ?").get(tenantId, name, version) ?? null;
  }

  #describe(row) {
    const active = this.#db.prepare("SELECT version FROM skill_active WHERE tenant_id = ? AND name = ?").get(row.tenant_id, row.name);
    return {
      tenantId: row.tenant_id, name: row.name, version: row.version, publisher: row.publisher, keyId: row.key_id,
      manifest: JSON.parse(row.manifest_json), manifestDigest: row.manifest_digest, approvalId: row.approval_id,
      installedBy: row.installed_by, installedAt: row.installed_at, uninstalledAt: row.uninstalled_at,
      testReport: JSON.parse(row.test_report_json), active: active?.version === row.version,
    };
  }

  getVersion(tenantId, name, version) {
    const row = this.#versionRow(tenantId, name, version);
    return row ? this.#describe(row) : null;
  }

  listVersions(tenantId, name) {
    return this.#db.prepare("SELECT * FROM skill_versions WHERE tenant_id = ? AND name = ?").all(tenantId, name)
      .map((row) => this.#describe(row)).sort((a, b) => compareSemver(a.version, b.version));
  }

  activeVersion(tenantId, name) {
    return this.#db.prepare("SELECT version FROM skill_active WHERE tenant_id = ? AND name = ?").get(tenantId, name)?.version ?? null;
  }

  listActive(tenantId) {
    return this.#db.prepare("SELECT name, version FROM skill_active WHERE tenant_id = ? ORDER BY name").all(tenantId).map((r) => ({ name: r.name, version: r.version }));
  }

  activate(tenantId, name, version, { actor }) {
    const who = actorKey(actor);
    try {
      const row = this.#versionRow(tenantId, name, version);
      if (!row || row.uninstalled_at) throw new SkillError("NOT_FOUND", `${name}@${version} is not installed in this tenant.`);
      this.#verifyStored(tenantId, row);
      const manifest = JSON.parse(row.manifest_json);
      const mine = new Set(manifest.tools.map((t) => t.name));
      for (const other of this.listActive(tenantId)) {
        if (other.name === name) continue;
        const clash = JSON.parse(this.#versionRow(tenantId, other.name, other.version).manifest_json).tools.find((t) => mine.has(t.name));
        if (clash) throw new SkillError("TOOL_CONFLICT", `Tool '${clash.name}' is already provided by active skill '${other.name}'.`);
      }
      const previous = this.activeVersion(tenantId, name);
      this.#db.prepare(
        `INSERT INTO skill_active (tenant_id, name, version, activated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (tenant_id, name) DO UPDATE SET version = excluded.version, activated_at = excluded.activated_at`,
      ).run(tenantId, name, version, this.#now());
      this.#audit(tenantId, "activate", "ok", { skill: name, version, actor: who, detail: { previous } });
      return { name, version, previous };
    } catch (error) {
      if (error instanceof SkillError) this.#audit(tenantId, "activate", "refused", { skill: name, version, actor: who, detail: { code: error.code, message: error.message } });
      throw error;
    }
  }

  deactivate(tenantId, name, { actor }) {
    const who = actorKey(actor);
    const previous = this.activeVersion(tenantId, name);
    if (!previous) throw new SkillError("NOT_ACTIVE", `Skill '${name}' is not active.`);
    this.#db.prepare("DELETE FROM skill_active WHERE tenant_id = ? AND name = ?").run(tenantId, name);
    this.#audit(tenantId, "deactivate", "ok", { skill: name, version: previous, actor: who, detail: {} });
    return { name, version: previous };
  }

  /** Activates the newest still-installed version older than the active one. */
  rollback(tenantId, name, { actor }) {
    const current = this.activeVersion(tenantId, name);
    if (!current) throw new SkillError("NOT_ACTIVE", `Skill '${name}' has no active version to roll back from.`);
    const candidates = this.listVersions(tenantId, name).filter((v) => !v.uninstalledAt && compareSemver(v.version, current) < 0);
    const target = candidates.at(-1);
    if (!target) throw new SkillError("NO_PREVIOUS_VERSION", `Skill '${name}' has no installed version older than ${current}.`);
    this.activate(tenantId, name, target.version, { actor });
    this.#audit(tenantId, "rollback", "ok", { skill: name, version: target.version, actor: actorKey(actor), detail: { from: current } });
    return { name, from: current, to: target.version };
  }

  uninstall(tenantId, name, version, { actor }) {
    const who = actorKey(actor);
    const row = this.#versionRow(tenantId, name, version);
    if (!row || row.uninstalled_at) throw new SkillError("NOT_FOUND", `${name}@${version} is not installed in this tenant.`);
    withTransaction(this.#db, () => {
      this.#db.prepare("DELETE FROM skill_active WHERE tenant_id = ? AND name = ? AND version = ?").run(tenantId, name, version);
      this.#db.prepare("UPDATE skill_versions SET uninstalled_at = ? WHERE tenant_id = ? AND name = ? AND version = ?").run(this.#now(), tenantId, name, version);
      this.#audit(tenantId, "uninstall", "ok", { skill: name, version, actor: who, detail: {} });
    });
    return { name, version, uninstalled: true };
  }

  // ---------------------------------------------------------------------------
  // Loading
  // ---------------------------------------------------------------------------

  /**
   * Re-verifies a stored version: manifest digest unchanged, signature still
   * valid under a currently trusted key, every pinned file in the store still
   * matching its digest. Returns `{ manifest, sources: {path: text} }`.
   */
  #verifyStored(tenantId, row) {
    const manifest = JSON.parse(row.manifest_json);
    if (manifestDigest(manifest) !== row.manifest_digest) throw new SkillError("INTEGRITY_FAILURE", "The stored manifest no longer matches its recorded digest.");
    const keyId = verifyManifestSignature(manifest, row.signature, this.#trustedKeys(tenantId, manifest.publisher));
    if (!keyId) throw new SkillError("UNTRUSTED_PUBLISHER", `The signature of ${row.name}@${row.version} no longer verifies against a trusted key.`);
    const sources = {};
    for (const [path, hash] of Object.entries(manifest.files)) {
      let text;
      try { text = readFileSync(this.#objectPath(hash), "utf8"); } catch { throw new SkillError("INTEGRITY_FAILURE", `Stored file '${path}' is missing.`); }
      if (sha256Hex(text) !== hash) throw new SkillError("INTEGRITY_FAILURE", `Stored file '${path}' does not match its signed digest.`);
      sources[path] = text;
    }
    return { manifest, sources };
  }

  /** Loads one active skill's tools. Throws SkillError when verification fails. */
  async loadSkill(tenantId, name) {
    const version = this.activeVersion(tenantId, name);
    if (!version) throw new SkillError("NOT_ACTIVE", `Skill '${name}' is not active.`);
    const row = this.#versionRow(tenantId, name, version);
    let verified;
    try {
      verified = this.#verifyStored(tenantId, row);
    } catch (error) {
      this.#audit(tenantId, "load", "refused", { skill: name, version, actor: null, detail: { code: error.code, message: error.message } });
      throw error;
    }
    const { manifest, sources } = verified;
    const modules = new Map();
    const tools = [];
    for (const declared of manifest.tools) {
      const { path, exportName } = parseEntry(declared.entry);
      if (!modules.has(path)) {
        const url = `data:text/javascript;base64,${Buffer.from(sources[path], "utf8").toString("base64")}`;
        modules.set(path, await import(url));
      }
      const fn = modules.get(path)[exportName];
      if (typeof fn !== "function") throw new SkillError("INVALID_PACKAGE", `Entry '${declared.entry}' does not export a function.`);
      const skill = Object.freeze({ name: manifest.name, version: manifest.version, publisher: manifest.publisher, permissions: [...manifest.permissions] });
      tools.push(defineTool({
        name: declared.name,
        description: declared.description,
        risk: declared.risk,
        consequential: declared.consequential,
        inputSchema: declared.inputSchema,
        execute: (input, context = {}) => fn(input, { ...context, skill }),
      }));
    }
    this.#audit(tenantId, "load", "ok", { skill: name, version, actor: null, detail: { tools: tools.map((t) => t.name) } });
    return tools;
  }

  /** Tools of every active skill; a skill that fails re-verification is reported in `refused`, never loaded. */
  async loadTools(tenantId) {
    const tools = [];
    const refused = [];
    for (const { name, version } of this.listActive(tenantId)) {
      try {
        tools.push(...await this.loadSkill(tenantId, name));
      } catch (error) {
        if (!(error instanceof SkillError)) throw error;
        refused.push({ name, version, code: error.code, message: error.message });
      }
    }
    return { tools, refused };
  }

  // ---------------------------------------------------------------------------
  // Audit and storage
  // ---------------------------------------------------------------------------

  auditLog(tenantId, { skill = undefined, limit = 500 } = {}) {
    const rows = skill === undefined
      ? this.#db.prepare("SELECT * FROM skill_audit WHERE tenant_id = ? ORDER BY seq LIMIT ?").all(tenantId, limit)
      : this.#db.prepare("SELECT * FROM skill_audit WHERE tenant_id = ? AND skill = ? ORDER BY seq LIMIT ?").all(tenantId, skill, limit);
    return rows.map((row) => ({
      seq: row.seq, action: row.action, outcome: row.outcome, skill: row.skill, version: row.version, actor: row.actor,
      detail: JSON.parse(row.detail_json), createdAt: row.created_at,
    }));
  }

  /** Path of a stored object, for operators and tests. */
  objectPath(hash) { return this.#objectPath(hash); }

  #objectPath(hash) {
    if (!/^[0-9a-f]{64}$/u.test(hash)) throw new SkillError("INVALID_INPUT", "Object ids are SHA-256 hex digests.");
    return join(this.#objects, hash);
  }

  #putObject(hash, text) {
    const target = this.#objectPath(hash);
    try {
      if (sha256Hex(readFileSync(target, "utf8")) === hash) return;
    } catch { /* absent: write it */ }
    // Written to a temp name and renamed, so a damaged object is replaced whole rather than patched.
    const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(temp, text, { mode: 0o400, flag: "wx" });
    renameSync(temp, target);
    chmodSync(target, 0o400);
  }

  #audit(tenantId, action, outcome, { skill = null, version = null, actor = null, detail = {} }) {
    this.#db.prepare(
      "INSERT INTO skill_audit (tenant_id, action, outcome, skill, version, actor, detail_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(tenantId, action, outcome, skill, version, actor, JSON.stringify(detail), this.#now());
  }

  #now() { return this.#clock().toISOString(); }
}

function requireTenant(tenantId) {
  if (typeof tenantId !== "string" || !tenantId) throw new SkillError("TENANT_REQUIRED", "Every skill operation must name its tenant.");
}

function safeActor(actor) {
  try { return actorKey(actor); } catch { return null; }
}
