import { digest, newId } from "../../../../../packages/atlas-contracts/src/index.mjs";
import { actorKey, requireHuman } from "./approvals.mjs";
import { SkillError, manifestDigest, validateManifest } from "./package.mjs";
import { buildTemplate, instantiateTemplate, templateDigest } from "./templates.mjs";

/**
 * Agent proposals for new skills and workflows (blueprint §13 G).
 *
 * An agent may write down a skill package or a workflow template together
 * with its rationale and tests. That is all it can do. The lifecycle is
 *
 *   proposed -> evaluate() -> tests_passed | tests_failed
 *   tests_passed -> approve(human, not the proposer) -> approved
 *   approved -> install(human) -> installed          (rejected at any point)
 *
 * No method in this module installs as a side effect of proposing,
 * evaluating or approving; `install` is a separate call that refuses unless
 * tests passed and a human other than the proposer approved, and it then
 * goes through the full registry gate (signature, digests, ceiling, tests
 * again) — a proposal is never a shortcut around install checks.
 *
 * Skill proposals are tested with the registry's test runner. Workflow
 * proposals declare tests as parameter sets (`[{ name, params }]`) that must
 * each instantiate into a valid plan against the available tool schemas.
 */
const KINDS = new Set(["skill", "workflow"]);

export class SkillProposals {
  #db;
  #registry;
  #templates;
  #clock;

  constructor({ db, registry = null, templates = null, clock = () => new Date() }) {
    this.#db = db;
    this.#registry = registry;
    this.#templates = templates;
    this.#clock = clock;
    db.exec(`
      CREATE TABLE IF NOT EXISTS skill_proposals (
        id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL, rationale TEXT NOT NULL,
        payload_json TEXT NOT NULL, subject_digest TEXT NOT NULL, proposed_by TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('proposed','tests_passed','tests_failed','approved','rejected','installed')),
        test_report_json TEXT, approval_id TEXT, decided_by TEXT, installed_ref TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS skill_proposals_tenant ON skill_proposals(tenant_id, status);
    `);
  }

  /**
   * `payload` is `{ package }` for a skill or `{ template, tests: [{ name, params }] }` for a workflow.
   */
  propose(tenantId, { kind, title, rationale, payload, proposedBy }) {
    if (!KINDS.has(kind)) throw new SkillError("INVALID_PROPOSAL", "A proposal is for a 'skill' or a 'workflow'.");
    if (typeof title !== "string" || !title.trim()) throw new SkillError("INVALID_PROPOSAL", "A proposal needs a title.");
    if (typeof rationale !== "string" || rationale.trim().length < 10) throw new SkillError("INVALID_PROPOSAL", "A proposal needs a rationale.");
    let subjectDigest;
    if (kind === "skill") {
      const manifest = validateManifest(payload?.package?.manifest);
      subjectDigest = manifestDigest(manifest);
    } else {
      const template = buildTemplate(payload?.template ?? {});
      if (!Array.isArray(payload?.tests) || payload.tests.length === 0) throw new SkillError("INVALID_PROPOSAL", "A workflow proposal needs test parameter sets.");
      subjectDigest = digest({ template: templateDigest(template), tests: payload.tests });
    }
    const id = `prp_${newId("artifact").slice(4)}`;
    const now = this.#clock().toISOString();
    this.#db.prepare(
      `INSERT INTO skill_proposals (id, tenant_id, kind, title, rationale, payload_json, subject_digest, proposed_by, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'proposed', ?, ?)`,
    ).run(id, tenantId, kind, title.trim(), rationale.trim(), JSON.stringify(payload), subjectDigest, actorKey(proposedBy), now, now);
    return this.get(tenantId, id);
  }

  get(tenantId, id) {
    const row = this.#db.prepare("SELECT * FROM skill_proposals WHERE id = ? AND tenant_id = ?").get(id, tenantId);
    if (!row) return null;
    return {
      id: row.id, tenantId: row.tenant_id, kind: row.kind, title: row.title, rationale: row.rationale,
      payload: JSON.parse(row.payload_json), subjectDigest: row.subject_digest, proposedBy: row.proposed_by, status: row.status,
      testReport: row.test_report_json ? JSON.parse(row.test_report_json) : null, approvalId: row.approval_id,
      decidedBy: row.decided_by, installedRef: row.installed_ref, createdAt: row.created_at, updatedAt: row.updated_at,
    };
  }

  list(tenantId, { status = undefined } = {}) {
    const rows = status === undefined
      ? this.#db.prepare("SELECT id FROM skill_proposals WHERE tenant_id = ? ORDER BY created_at, id").all(tenantId)
      : this.#db.prepare("SELECT id FROM skill_proposals WHERE tenant_id = ? AND status = ? ORDER BY created_at, id").all(tenantId, status);
    return rows.map((row) => this.get(tenantId, row.id));
  }

  #require(tenantId, id) {
    const proposal = this.get(tenantId, id);
    if (!proposal) throw new SkillError("NOT_FOUND", "No such proposal in this tenant.");
    return proposal;
  }

  #update(tenantId, id, fields) {
    const sets = Object.keys(fields).map((key) => `${key} = ?`);
    this.#db.prepare(`UPDATE skill_proposals SET ${sets.join(", ")}, updated_at = ? WHERE id = ? AND tenant_id = ?`)
      .run(...Object.values(fields), this.#clock().toISOString(), id, tenantId);
    return this.get(tenantId, id);
  }

  /** Runs the proposal's tests. Moves it to tests_passed or tests_failed; installs nothing. */
  async evaluate(tenantId, id) {
    const proposal = this.#require(tenantId, id);
    if (!["proposed", "tests_failed", "tests_passed"].includes(proposal.status)) {
      throw new SkillError("INVALID_STATE", `A proposal in '${proposal.status}' cannot be re-evaluated.`);
    }
    let report;
    if (proposal.kind === "skill") {
      if (!this.#registry) throw new SkillError("MISCONFIGURED", "Evaluating a skill proposal needs a registry.");
      report = await this.#registry.runPackageTests(tenantId, proposal.payload.package);
    } else {
      const template = buildTemplate(proposal.payload.template);
      const resolve = (name) => this.#templates?.resolveTool(name) ?? null;
      const results = proposal.payload.tests.map((test) => {
        try {
          const plan = instantiateTemplate(template, test.params ?? {}, resolve);
          return { name: String(test.name), ok: true, steps: plan.steps.length };
        } catch (error) {
          return { name: String(test.name), ok: false, error: `${error.code ?? "ERROR"}: ${error.message}`.slice(0, 500) };
        }
      });
      report = { ok: results.every((r) => r.ok), results };
    }
    return this.#update(tenantId, id, { status: report.ok ? "tests_passed" : "tests_failed", test_report_json: JSON.stringify(report) });
  }

  /** A human other than the proposer approves a proposal whose tests passed. */
  approve(tenantId, id, { approver }) {
    const approverKey = requireHuman(approver, "approval of a proposal");
    const proposal = this.#require(tenantId, id);
    if (proposal.proposedBy === approverKey) throw new SkillError("SELF_APPROVAL", "A proposer cannot approve its own proposal.");
    if (proposal.status !== "tests_passed") throw new SkillError("TESTS_REQUIRED", `Only a proposal whose tests passed can be approved; this one is '${proposal.status}'.`);
    const approvals = this.#approvals(proposal.kind);
    const kind = proposal.kind === "skill" ? "skill.install" : "workflow.template.save";
    let approvalId = null;
    if (proposal.kind === "skill") {
      const approval = approvals.request({ tenantId, kind, subjectDigest: proposal.subjectDigest, requestedBy: parseActor(proposal.proposedBy), summary: `proposal ${id}` });
      approvals.resolve(tenantId, approval.id, { approver, decision: "approved" });
      approvalId = approval.id;
    }
    return this.#update(tenantId, id, { status: "approved", approval_id: approvalId, decided_by: approverKey });
  }

  reject(tenantId, id, { approver, reason = null }) {
    const approverKey = requireHuman(approver, "rejection of a proposal");
    const proposal = this.#require(tenantId, id);
    if (proposal.status === "installed") throw new SkillError("INVALID_STATE", "An installed proposal cannot be rejected; uninstall the skill instead.");
    return this.#update(tenantId, id, { status: "rejected", decided_by: approverKey, test_report_json: JSON.stringify({ ...(proposal.testReport ?? {}), rejection: reason }) });
  }

  /**
   * Installs an approved proposal, by a human. Skills go through
   * `registry.install` (every gate, tests re-run); workflows are drafted and
   * saved under a fresh approval by the same approver.
   */
  async install(tenantId, id, { installedBy }) {
    const installerKey = requireHuman(installedBy, "install of a proposal");
    const proposal = this.#require(tenantId, id);
    if (proposal.status !== "approved") throw new SkillError("APPROVAL_REQUIRED", `A proposal must be approved by a human before it is installed; this one is '${proposal.status}'.`);
    if (proposal.proposedBy === installerKey) throw new SkillError("SELF_APPROVAL", "A proposer cannot install its own proposal.");
    if (proposal.kind === "skill") {
      if (!this.#registry) throw new SkillError("MISCONFIGURED", "Installing a skill proposal needs a registry.");
      const approver = parseActor(proposal.decidedBy);
      const installed = await this.#registry.install(proposal.payload.package, { tenantId, approvalId: proposal.approvalId, approvedBy: approver, installedBy });
      return this.#update(tenantId, id, { status: "installed", installed_ref: `${installed.name}@${installed.version}` });
    }
    if (!this.#templates) throw new SkillError("MISCONFIGURED", "Installing a workflow proposal needs a template store.");
    const { template, approval } = this.#templates.draftFromDefinition(tenantId, proposal.payload.template, { draftedBy: parseActor(proposal.proposedBy) });
    this.#templates.approvals.resolve(tenantId, approval.id, { approver: parseActor(proposal.decidedBy), decision: "approved" });
    const saved = this.#templates.save(tenantId, template.id, { approvalId: approval.id, approvedBy: parseActor(proposal.decidedBy) });
    return this.#update(tenantId, id, { status: "installed", installed_ref: saved.id });
  }

  #approvals(kind) {
    const source = kind === "skill" ? this.#registry : this.#templates;
    if (!source) throw new SkillError("MISCONFIGURED", `Approving a ${kind} proposal needs its store.`);
    return source.approvals;
  }
}

/** Inverse of actorKey for the two prefixes it produces. */
export function parseActor(key) {
  const [kind, ...rest] = String(key).split(":");
  const id = rest.join(":");
  return kind === "agent" ? { agentId: id } : { userId: id };
}
