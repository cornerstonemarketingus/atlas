import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * The Credential Broker: agents ask for a capability, never for a secret.
 *
 *   agent → request(capability, resource) → policy (approval mode × risk)
 *         → approval (bound to this exact action, single use) when needed
 *         → short-lived lease → use(lease, adapter) → authenticated call
 *
 * Values live only in the credential vault (OS keychain or encrypted file);
 * this module stores records about them: which provider, account and
 * environment a credential belongs to, its type, the capabilities granted
 * to it, when it expires, when it last worked, and how it last validated.
 * An adapter receives the value inside `use()` and nothing it returns leaves
 * unredacted. Every request and use is written to an append-only audit
 * trail, with the credential reference and never the credential.
 */

export const CREDENTIAL_TYPES = Object.freeze([
  "API_TOKEN", "API_KEY", "OAUTH_ACCESS_TOKEN", "OAUTH_REFRESH_TOKEN", "SESSION", "PASSWORD",
  "SSH_KEY", "SERVICE_ACCOUNT", "PASSKEY_REFERENCE", "EPHEMERAL_TOKEN",
]);

export const APPROVAL_MODES = Object.freeze(["SAFE", "BALANCED", "AUTONOMOUS"]);

/**
 * What each capability does, as an autonomy level (kernel/autonomy.mjs):
 * 0–1 reads and sandboxed work, 2 restorable changes, 3 external changes,
 * 4 production, money or secrets. Level 5 (never on its own) is never
 * catalogued, so asking for it is UNKNOWN_CAPABILITY.
 */
export const CAPABILITIES = Object.freeze({
  "github.repo.read": { provider: "github", level: 0 },
  "github.repo.write": { provider: "github", level: 2 },
  "github.pr.create": { provider: "github", level: 3 },
  "github.pr.merge": { provider: "github", level: 4 },
  "cloudflare.workers.read": { provider: "cloudflare", level: 0 },
  "cloudflare.ai.run": { provider: "cloudflare", level: 1 },
  "cloudflare.workers.deploy": { provider: "cloudflare", level: 4 },
  "cloudflare.workers.secrets.write": { provider: "cloudflare", level: 4 },
  "vercel.deploy": { provider: "vercel", level: 4 },
  "google.drive.read": { provider: "google", level: 0 },
  "browser.login": { provider: "browser", level: 3 },
});

/** Why a credential could not be used, as one fixed category. */
export const FAILURE_CATEGORIES = Object.freeze([
  "CREDENTIAL_MISSING", "CREDENTIAL_INVALID", "CREDENTIAL_EXPIRED", "CREDENTIAL_REVOKED", "WRONG_ACCOUNT",
  "INSUFFICIENT_PERMISSION", "AUTH_SCHEME_MISMATCH", "PROVIDER_RATE_LIMIT", "BILLING_EXHAUSTED", "PROVIDER_UNAVAILABLE",
  "CAPABILITY_NOT_GRANTED", "UNKNOWN_CAPABILITY", "APPROVAL_DENIED", "LEASE_INVALID",
]);

export class CredentialError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "CredentialError";
    this.code = code;
  }
}

const LEASE_TTL_MS = 5 * 60_000;
const PROVIDER = /^[a-z][a-z0-9-]{1,31}$/u;
const VAULT_NAME = /^[A-Z][A-Z0-9_]{2,63}$/u;

/**
 * Classifies a provider's refusal. 401 is not always "the token is wrong":
 * Cloudflare answers 401 with error 10000 when a valid token lacks the
 * permission or belongs to another account.
 */
export function classifyAuthFailure({ provider = null, status, codes = [] }) {
  if (status === 402) return "BILLING_EXHAUSTED";
  if (status === 429) return "PROVIDER_RATE_LIMIT";
  if (status === 0 || status >= 500) return "PROVIDER_UNAVAILABLE";
  if (provider === "cloudflare" && codes.includes(10000)) return status === 403 ? "INSUFFICIENT_PERMISSION" : "WRONG_ACCOUNT";
  if (provider === "cloudflare" && codes.includes(1000)) return "CREDENTIAL_INVALID";
  if (status === 401) return "CREDENTIAL_INVALID";
  if (status === 403) return "INSUFFICIENT_PERMISSION";
  return "PROVIDER_UNAVAILABLE";
}

/** The digest an approval for one credential use is bound to: agent, capability, connection and resource. */
export function credentialActionDigest({ agentId, capability, connectionId, resource }) {
  return createHash("sha256").update(JSON.stringify({ kind: "credential.use", agentId, capability, connectionId, resource })).digest("hex");
}

export class CredentialStore {
  #db;

  constructor(filename = ":memory:") {
    if (filename !== ":memory:") mkdirSync(dirname(filename), { recursive: true });
    this.#db = new DatabaseSync(filename);
    this.#db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS credential_connections (
        id TEXT PRIMARY KEY, provider TEXT NOT NULL, account TEXT NOT NULL, environment TEXT NOT NULL,
        type TEXT NOT NULL, vault_ref TEXT NOT NULL, capabilities TEXT NOT NULL, expires_at TEXT,
        status TEXT NOT NULL, last_used_at TEXT, last_validation TEXT, created_at TEXT NOT NULL, revoked_at TEXT
      );
      CREATE TABLE IF NOT EXISTS credential_grants (
        connection_id TEXT NOT NULL, capability TEXT NOT NULL, granted_at TEXT NOT NULL, approval_id TEXT,
        PRIMARY KEY (connection_id, capability)
      );
      CREATE TABLE IF NOT EXISTS credential_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS credential_audit (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, agent TEXT NOT NULL, capability TEXT NOT NULL,
        connection_id TEXT, credential_ref TEXT, provider TEXT, resource TEXT, decision TEXT NOT NULL,
        approval_id TEXT, result TEXT
      );
      CREATE TRIGGER IF NOT EXISTS credential_audit_no_update BEFORE UPDATE ON credential_audit BEGIN SELECT RAISE(ABORT, 'The credential audit trail is append-only'); END;
      CREATE TRIGGER IF NOT EXISTS credential_audit_no_delete BEFORE DELETE ON credential_audit BEGIN SELECT RAISE(ABORT, 'The credential audit trail is append-only'); END;
    `);
  }

  close() { this.#db.close(); }

  #row(row) {
    return row ? {
      id: row.id, provider: row.provider, account: row.account, environment: row.environment, type: row.type, vaultRef: row.vault_ref,
      capabilities: JSON.parse(row.capabilities), expiresAt: row.expires_at, status: row.status, lastUsedAt: row.last_used_at,
      lastValidation: row.last_validation ? JSON.parse(row.last_validation) : null, createdAt: row.created_at, revokedAt: row.revoked_at,
    } : null;
  }

  insert(record) {
    this.#db.prepare("INSERT INTO credential_connections (id, provider, account, environment, type, vault_ref, capabilities, expires_at, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(record.id, record.provider, record.account, record.environment, record.type, record.vaultRef, JSON.stringify(record.capabilities), record.expiresAt, "connected", record.createdAt);
    return this.get(record.id);
  }

  get(id) { return this.#row(this.#db.prepare("SELECT * FROM credential_connections WHERE id = ?").get(id)); }
  list() { return this.#db.prepare("SELECT * FROM credential_connections ORDER BY provider, account, environment, created_at").all().map((row) => this.#row(row)); }
  update(id, fields) {
    const columns = { status: "status", lastUsedAt: "last_used_at", lastValidation: "last_validation", revokedAt: "revoked_at" };
    for (const [key, value] of Object.entries(fields)) {
      this.#db.prepare(`UPDATE credential_connections SET ${columns[key]} = ? WHERE id = ?`).run(key === "lastValidation" ? JSON.stringify(value) : value, id);
    }
    return this.get(id);
  }

  grant(connectionId, capability, at, approvalId) {
    this.#db.prepare("INSERT OR REPLACE INTO credential_grants (connection_id, capability, granted_at, approval_id) VALUES (?, ?, ?, ?)").run(connectionId, capability, at, approvalId);
  }
  granted(connectionId, capability) { return Boolean(this.#db.prepare("SELECT 1 FROM credential_grants WHERE connection_id = ? AND capability = ?").get(connectionId, capability)); }
  dropGrants(connectionId) { this.#db.prepare("DELETE FROM credential_grants WHERE connection_id = ?").run(connectionId); }

  setting(key, fallback) { return this.#db.prepare("SELECT value FROM credential_settings WHERE key = ?").get(key)?.value ?? fallback; }
  setSetting(key, value) { this.#db.prepare("INSERT INTO credential_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value); }

  audit(entry) {
    this.#db.prepare("INSERT INTO credential_audit (at, agent, capability, connection_id, credential_ref, provider, resource, decision, approval_id, result) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(entry.at, entry.agent, entry.capability, entry.connectionId ?? null, entry.credentialRef ?? null, entry.provider ?? null, entry.resource ?? null, entry.decision, entry.approvalId ?? null, entry.result ?? null);
  }
  auditTrail(limit = 200) {
    return this.#db.prepare("SELECT * FROM credential_audit ORDER BY seq DESC LIMIT ?").all(limit).map((row) => ({
      seq: row.seq, at: row.at, agent: row.agent, capability: row.capability, connectionId: row.connection_id, credentialRef: row.credential_ref,
      provider: row.provider, resource: row.resource, decision: row.decision, approvalId: row.approval_id, result: row.result,
    }));
  }
}

/**
 * @param {{ store: CredentialStore, vault: { get(name): Promise<string|null>, set(name, value): Promise<unknown>, delete?(name): Promise<unknown> },
 *   approvals?: { check(digest): Promise<boolean>|boolean, request(request): unknown }, redact?: (text: string) => string, clock?: () => Date }} options
 */
export class CredentialBroker {
  #store;
  #vault;
  #approvals;
  #redact;
  #clock;
  #leases = new Map();
  #known = new Set();

  constructor({ store, vault, approvals = null, redact = (text) => text, clock = () => new Date() }) {
    this.#store = store;
    this.#vault = vault;
    this.#approvals = approvals;
    this.#redact = redact;
    this.#clock = clock;
  }

  get mode() { return this.#store.setting("approval_mode", "BALANCED"); }
  setMode(mode) {
    if (!APPROVAL_MODES.includes(mode)) throw new CredentialError("INVALID_MODE", `Approval mode must be one of ${APPROVAL_MODES.join(", ")}.`);
    this.#store.setSetting("approval_mode", mode);
    return mode;
  }

  /** Secret values the broker has handed to adapters, for the redactor (in memory only). */
  knownSecrets() { return [...this.#known]; }

  /**
   * Registers a connection. A secret, when given, goes straight into the
   * vault under `vaultRef` and is not kept or returned.
   */
  async connect({ provider, account, environment = "production", type, vaultRef, capabilities = [], expiresAt = null, secret = undefined }) {
    if (!PROVIDER.test(provider ?? "")) throw new CredentialError("INVALID_CONNECTION", "A provider is a short lowercase name.");
    if (typeof account !== "string" || !account.trim() || account.length > 200) throw new CredentialError("INVALID_CONNECTION", "Name the account this credential belongs to.");
    if (!CREDENTIAL_TYPES.includes(type)) throw new CredentialError("INVALID_CONNECTION", `Credential type must be one of ${CREDENTIAL_TYPES.join(", ")}.`);
    if (!VAULT_NAME.test(vaultRef ?? "")) throw new CredentialError("INVALID_CONNECTION", "A vault reference is 3-64 characters of A-Z, 0-9 and underscore.");
    for (const capability of capabilities) {
      const known = CAPABILITIES[capability];
      if (!known) throw new CredentialError("UNKNOWN_CAPABILITY", `Unknown capability '${capability}'.`);
      if (known.provider !== provider) throw new CredentialError("INVALID_CONNECTION", `'${capability}' is not a ${provider} capability.`);
    }
    if (expiresAt !== null && !Number.isFinite(Date.parse(expiresAt))) throw new CredentialError("INVALID_CONNECTION", "expiresAt must be a date.");
    if (secret !== undefined) {
      if (typeof secret !== "string" || !secret) throw new CredentialError("INVALID_CONNECTION", "A credential value cannot be empty.");
      await this.#vault.set(vaultRef, secret);
    }
    return this.#public(this.#store.insert({
      id: randomUUID(), provider, account: account.trim(), environment, type, vaultRef, capabilities: [...new Set(capabilities)],
      expiresAt, createdAt: this.#clock().toISOString(),
    }));
  }

  /** Connections as the owner sees them: never the value, never the vault reference's content. */
  connections() { return this.#store.list().map((record) => this.#public(this.#refresh(record))); }

  async revoke(id) {
    const record = this.#store.get(id);
    if (!record) throw new CredentialError("UNKNOWN_CONNECTION", "Connection not found.");
    await this.#vault.delete?.(record.vaultRef).catch(() => {});
    this.#store.dropGrants(id);
    for (const [leaseId, lease] of this.#leases) if (lease.connectionId === id) this.#leases.delete(leaseId);
    return this.#public(this.#store.update(id, { status: "revoked", revokedAt: this.#clock().toISOString() }));
  }

  /**
   * Checks a connection with a provider validator `(secret) => { category, account? }`
   * and records the outcome; a validator reporting another account is WRONG_ACCOUNT.
   */
  async validate(id, validator) {
    const record = this.#store.get(id);
    if (!record) throw new CredentialError("UNKNOWN_CONNECTION", "Connection not found.");
    const secret = await this.#vault.get(record.vaultRef).catch(() => null);
    let outcome;
    if (!secret) outcome = { category: "CREDENTIAL_MISSING" };
    else {
      this.#known.add(secret);
      try {
        const result = await validator(secret);
        outcome = result.account && result.account !== record.account ? { category: "WRONG_ACCOUNT", reportedAccount: String(result.account).slice(0, 200) } : { category: result.category ?? "OK" };
      } catch (error) {
        outcome = { category: classifyAuthFailure({ provider: record.provider, status: Number(error?.status) || 0, codes: error?.codes ?? [] }) };
      }
    }
    const validation = { ...outcome, at: this.#clock().toISOString() };
    return this.#public(this.#store.update(id, { lastValidation: validation, ...(outcome.category === "OK" ? { status: "connected" } : { status: "attention" }) }));
  }

  /**
   * An agent asks to act with a capability on a resource. Returns a lease,
   * an approval to wait for (bound to this exact action), or a refusal with
   * its category. Never the credential.
   */
  async request({ agentId, capability, resource = "", account = null, environment = null }) {
    const definition = CAPABILITIES[capability];
    const at = this.#clock().toISOString();
    const audit = (decision, extra = {}) => this.#store.audit({ at, agent: String(agentId), capability, resource, decision, ...extra });
    if (!definition) { audit("denied", { result: "UNKNOWN_CAPABILITY" }); return { status: "denied", code: "UNKNOWN_CAPABILITY" }; }

    const candidates = this.#store.list().map((record) => this.#refresh(record)).filter((record) => record.provider === definition.provider);
    const scoped = candidates.filter((record) => (!account || record.account === account) && (!environment || record.environment === environment));
    const usable = scoped.filter((record) => record.status === "connected" || record.status === "attention");
    const record = usable.find((entry) => entry.capabilities.includes(capability));
    if (!record) {
      const code = scoped.some((entry) => entry.status === "expired") ? "CREDENTIAL_EXPIRED"
        : scoped.some((entry) => entry.status === "revoked") && !usable.length ? "CREDENTIAL_REVOKED"
          : candidates.length && !scoped.length ? "WRONG_ACCOUNT"
            : usable.length ? "CAPABILITY_NOT_GRANTED" : "CREDENTIAL_MISSING";
      audit("denied", { provider: definition.provider, result: code });
      return { status: "denied", code };
    }
    const reference = { connectionId: record.id, credentialRef: record.vaultRef, provider: record.provider };

    const digest = credentialActionDigest({ agentId: String(agentId), capability, connectionId: record.id, resource });
    if (this.#needsApproval(definition.level, record.id, capability)) {
      const approved = this.#approvals ? await this.#approvals.check(digest) : false;
      if (!approved) {
        const approval = await this.#approvals?.request?.({
          digest, capability: `credential.${capability}`, riskLevel: definition.level,
          summary: `Use ${record.provider} (${record.account}, ${record.environment}) for ${capability}${resource ? ` on ${resource}` : ""}`,
        });
        audit("approval-required", { ...reference, approvalId: approval?.id ?? null });
        return { status: "approval-required", digest, approvalId: approval?.id ?? null, capability, connection: this.#public(record), riskLevel: definition.level };
      }
      // An approved, previously unseen capability is remembered for BALANCED mode.
      this.#store.grant(record.id, capability, at, digest);
    }
    const lease = { id: randomUUID(), agentId: String(agentId), capability, resource, connectionId: record.id, expiresAt: this.#clock().getTime() + LEASE_TTL_MS };
    this.#leases.set(lease.id, lease);
    audit("granted", reference);
    return { status: "granted", lease: { id: lease.id, capability, resource, expiresAt: new Date(lease.expiresAt).toISOString(), connection: this.#public(record) } };
  }

  /**
   * Runs `adapter({ secret, connection })` under a lease, once. The secret
   * never leaves this call; what the adapter returns or throws is redacted.
   */
  async use(leaseId, { capability, resource = "" }, adapter) {
    const lease = this.#leases.get(leaseId);
    this.#leases.delete(leaseId);
    const at = this.#clock().toISOString();
    if (!lease || lease.capability !== capability || lease.resource !== resource || lease.expiresAt < this.#clock().getTime()) {
      this.#store.audit({ at, agent: lease?.agentId ?? "unknown", capability, resource, decision: "refused", result: "LEASE_INVALID" });
      throw new CredentialError("LEASE_INVALID", "This lease is unknown, expired, already used, or for another action.");
    }
    const record = this.#store.get(lease.connectionId);
    const reference = { connectionId: record.id, credentialRef: record.vaultRef, provider: record.provider };
    const secret = record.status === "revoked" ? null : await this.#vault.get(record.vaultRef).catch(() => null);
    if (!secret) {
      this.#store.audit({ at, agent: lease.agentId, capability, resource, decision: "used", ...reference, result: "CREDENTIAL_MISSING" });
      throw new CredentialError("CREDENTIAL_MISSING", `The ${record.provider} credential for ${record.account} is not in the vault.`);
    }
    this.#known.add(secret);
    try {
      const result = await adapter({ secret, connection: { provider: record.provider, account: record.account, environment: record.environment } });
      this.#store.update(record.id, { lastUsedAt: at });
      this.#store.audit({ at, agent: lease.agentId, capability, resource, decision: "used", ...reference, result: "OK" });
      return this.#scrub(result, secret);
    } catch (error) {
      const category = error?.status !== undefined ? classifyAuthFailure({ provider: record.provider, status: Number(error.status), codes: error.codes ?? [] }) : "PROVIDER_UNAVAILABLE";
      this.#store.audit({ at, agent: lease.agentId, capability, resource, decision: "used", ...reference, result: category });
      throw new CredentialError(category, this.#scrub(error instanceof Error ? error.message : "The authenticated call failed.", secret));
    }
  }

  auditTrail(limit) { return this.#store.auditTrail(limit); }

  #needsApproval(level, connectionId, capability) {
    const mode = this.mode;
    if (level >= 4) return true;                       // production, money, secrets: always the owner
    if (mode === "SAFE") return level >= 2;            // ask before any external change
    if (mode === "BALANCED") return level >= 3 && !this.#store.granted(connectionId, capability);
    return false;                                      // AUTONOMOUS: granted capabilities up to level 3
  }

  #refresh(record) {
    if (record.status === "connected" && record.expiresAt && Date.parse(record.expiresAt) <= this.#clock().getTime()) return this.#store.update(record.id, { status: "expired" });
    return record;
  }

  #scrub(value, secret) {
    const clean = (text) => this.#redact(String(text).split(secret).join("[redacted:credential]"));
    if (typeof value === "string") return clean(value);
    if (value === undefined || value === null) return value;
    return JSON.parse(clean(JSON.stringify(value)));
  }

  #public(record) {
    if (!record) return null;
    const { vaultRef, ...rest } = record;
    return { ...rest, credential: vaultRef ? "stored in vault" : "missing" };
  }
}
