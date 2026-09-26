import { randomUUID } from "node:crypto";

import { digest, newCorrelationId } from "../../../../../packages/atlas-contracts/src/index.mjs";

import { permissionsCover } from "../family/family-graph.mjs";
import { TaskDelegation } from "../family/delegation.mjs";
import { INNOVATION_PERMISSIONS, PEER_ORGANIZATIONS } from "../family/default-families.mjs";
import {
  ACTIVE_STATES,
  InnovationError,
  OPPORTUNITY_STATES,
  assertOpportunityTransition,
  briefFingerprintText,
  coverage,
  jaccard,
  tokenize,
  validateCouncilReview,
  validateImplementationProposal,
  validateOpportunityBrief,
} from "./brief.mjs";

/**
 * The closed product-development loop:
 *
 *   discover → research → validate → propose → council → Decision Packet →
 *   human approval → commission peers → build → verify → launch → measure →
 *   learn → discover the next opportunity.
 *
 * Every step is a durable, tenant-scoped state change with an append-only
 * event, stored in the family graph's own database so that an opportunity's
 * transition and the delegation it causes commit in one transaction.
 *
 * Three boundaries are structural rather than conventional:
 *
 * - Agents act only through permissions they hold (INNOVATION_PERMISSIONS);
 *   roles and names select council members but never authorize anything.
 * - No agent can approve a build or a launch. Those decisions take a human
 *   principal (or an explicitly configured low-risk policy) and are bound to
 *   the digest of the exact Decision Packet that was reviewed, so a packet
 *   changed after review cannot ride an earlier approval.
 * - Opportunity Memory is consulted before anything new enters the backlog:
 *   an idea that is already in flight, or was rejected, cannot be silently
 *   rediscovered; resubmitting a rejected idea requires naming it and bringing
 *   evidence it did not have.
 */

export const DEFAULT_INNOVATION_POLICY = Object.freeze({
  version: "innovation.v1",
  /** Similarity (0–1) at or above which a new brief is treated as a duplicate. */
  duplicateThreshold: 0.45,
  /** Similarity at or above which memory entries are shown as related. */
  relatedThreshold: 0.15,
  /** Efforts that convene a full review council. */
  councilEfforts: ["Medium", "Large", "Major"],
  /**
   * Efforts a policy may approve without a human. Empty by default: every
   * build needs a person. A repository owner may narrow this to ["Small"].
   */
  autoApproveEfforts: [],
  maxRepairAttempts: 3,
});

/** Council seats: who is asked, selected by role (selection only — never authority). */
const COUNCIL_SEATS = Object.freeze([
  { seat: "Business Development", role: "business_development_executive" },
  { seat: "Product", role: "product_executive" },
  { seat: "Research", role: "parent", family: "research" },
  { seat: "Architecture", role: "architecture" },
  { seat: "Design", role: "product_design" },
  { seat: "Security", role: "security" },
  { seat: "Finance / Cost", role: "finance" },
  { seat: "Customer Advocate", role: "customer_success" },
  { seat: "Engineering", role: "parent", family: "engineering" },
]);

const PERMISSION_FOR_BUILD_VERIFICATION = ["terminal.run_tests", "visual.inspect", "security.scan"];

function newOpportunityId() {
  return `opp_${randomUUID().replaceAll("-", "")}`;
}

function requireTenant(tenantId) {
  if (typeof tenantId !== "string" || !tenantId || tenantId.length > 128) {
    throw new InnovationError("TENANT_REQUIRED", "A tenantId is required for every innovation operation.");
  }
  return tenantId;
}

function requireText(value, field, max = 4000) {
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw new InnovationError("INVALID_ARGUMENT", `'${field}' must be text of 1–${max} characters.`, { field });
  }
  return value.trim();
}

function textList(value, field, { min = 0, max = 20 } = {}) {
  if (!Array.isArray(value) || value.length < min || value.length > max) {
    throw new InnovationError("INVALID_ARGUMENT", `'${field}' must be a list of ${min}–${max} entries.`, { field });
  }
  return value.map((entry, i) => requireText(entry, `${field}[${i}]`, 2000));
}

export class InnovationPipeline {
  #reg;
  #delegation;
  #platform;
  #policy;
  #approvals;

  /**
   * @param {object} options
   * @param {import("../family/family-graph.mjs").AgentFamilyRegistry} options.registry
   * @param {TaskDelegation} [options.delegation]
   * @param {import("../task-store.mjs").PlatformTaskStore|null} [options.platformStore] canonical task lifecycle for builds
   * @param {{ request: Function, resolve: Function }|null} [options.approvals] human approval inbox
   * @param {object} [options.policy]
   */
  constructor({ registry, delegation = new TaskDelegation(registry), platformStore = null, approvals = null, policy = {} }) {
    if (!registry) throw new TypeError("registry is required.");
    this.#reg = registry;
    this.#delegation = delegation;
    this.#platform = platformStore;
    this.#approvals = approvals;
    this.#policy = { ...DEFAULT_INNOVATION_POLICY, ...policy };
    registry.db.exec(`
      CREATE TABLE IF NOT EXISTS opportunities (
        tenant_id TEXT NOT NULL, id TEXT NOT NULL, title TEXT NOT NULL, state TEXT NOT NULL,
        correlation_id TEXT NOT NULL, submitted_by TEXT NOT NULL, supersedes TEXT,
        brief_json TEXT NOT NULL, research_json TEXT, proposal_json TEXT, council_json TEXT,
        packet_json TEXT, packet_digest TEXT, approval_id TEXT, decision_json TEXT, launch_json TEXT,
        build_json TEXT, repair_attempts INTEGER NOT NULL DEFAULT 0, outcome_json TEXT,
        rejection_reason TEXT, version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        PRIMARY KEY (tenant_id, id));
      CREATE INDEX IF NOT EXISTS opportunities_state_idx ON opportunities(tenant_id, state, updated_at);
      CREATE INDEX IF NOT EXISTS opportunities_approval_idx ON opportunities(approval_id);
      CREATE TABLE IF NOT EXISTS opportunity_events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id TEXT NOT NULL, opportunity_id TEXT NOT NULL,
        type TEXT NOT NULL, actor TEXT NOT NULL, from_state TEXT, to_state TEXT, payload TEXT NOT NULL, at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS opportunity_events_idx ON opportunity_events(tenant_id, opportunity_id, seq);
      CREATE TRIGGER IF NOT EXISTS opportunity_events_no_update BEFORE UPDATE ON opportunity_events BEGIN SELECT RAISE(ABORT, 'opportunity_events are append-only'); END;
      CREATE TRIGGER IF NOT EXISTS opportunity_events_no_delete BEFORE DELETE ON opportunity_events BEGIN SELECT RAISE(ABORT, 'opportunity_events are append-only'); END;
      CREATE TABLE IF NOT EXISTS opportunity_reviews (
        tenant_id TEXT NOT NULL, opportunity_id TEXT NOT NULL, round INTEGER NOT NULL, agent_id TEXT NOT NULL,
        seat TEXT NOT NULL, review_json TEXT NOT NULL, at TEXT NOT NULL,
        PRIMARY KEY (tenant_id, opportunity_id, round, agent_id));
      CREATE TABLE IF NOT EXISTS opportunity_measurements (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id TEXT NOT NULL, opportunity_id TEXT NOT NULL,
        metric TEXT NOT NULL, before_value TEXT, after_value TEXT NOT NULL, source TEXT NOT NULL, recorded_by TEXT NOT NULL, at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS opportunity_lessons (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id TEXT NOT NULL, opportunity_id TEXT NOT NULL,
        lesson TEXT NOT NULL, recorded_by TEXT NOT NULL, at TEXT NOT NULL);
      CREATE TRIGGER IF NOT EXISTS opportunity_lessons_no_update BEFORE UPDATE ON opportunity_lessons BEGIN SELECT RAISE(ABORT, 'opportunity_lessons are append-only'); END;
      CREATE TRIGGER IF NOT EXISTS opportunity_lessons_no_delete BEFORE DELETE ON opportunity_lessons BEGIN SELECT RAISE(ABORT, 'opportunity_lessons are append-only'); END;
    `);
  }

  get policy() { return structuredClone(this.#policy); }
  get delegation() { return this.#delegation; }

  // -------------------------------------------------------------------------
  // Rows and events
  // -------------------------------------------------------------------------

  #row(tenantId, id) {
    return this.#reg.db.prepare("SELECT * FROM opportunities WHERE tenant_id = ? AND id = ?").get(tenantId, id);
  }

  #hydrate(row) {
    if (!row) return null;
    const parse = (value) => (value === null || value === undefined ? null : JSON.parse(value));
    return {
      id: row.id,
      tenantId: row.tenant_id,
      title: row.title,
      state: row.state,
      correlationId: row.correlation_id,
      submittedBy: row.submitted_by,
      supersedes: row.supersedes,
      brief: parse(row.brief_json),
      research: parse(row.research_json),
      proposal: parse(row.proposal_json),
      council: parse(row.council_json),
      decisionPacket: parse(row.packet_json),
      packetDigest: row.packet_digest,
      approvalId: row.approval_id,
      decision: parse(row.decision_json),
      launch: parse(row.launch_json),
      build: parse(row.build_json),
      repairAttempts: row.repair_attempts,
      outcome: parse(row.outcome_json),
      rejectionReason: row.rejection_reason,
      version: row.version,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  get(tenantId, id) {
    requireTenant(tenantId);
    return this.#hydrate(this.#row(tenantId, id));
  }

  #require(tenantId, id) {
    const opportunity = this.get(tenantId, id);
    if (!opportunity) throw new InnovationError("OPPORTUNITY_NOT_FOUND", `Opportunity '${id}' does not exist in this tenant.`);
    return opportunity;
  }

  #event(tenantId, id, type, actor, { from = null, to = null, payload = {} } = {}) {
    this.#reg.db.prepare("INSERT INTO opportunity_events (tenant_id, opportunity_id, type, actor, from_state, to_state, payload, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(tenantId, id, type, actor, from, to, JSON.stringify(payload), this.#reg.now());
  }

  /** Writes columns and (optionally) a state change plus its event, atomically. */
  #update(tenantId, opportunity, { to = null, actor, type, payload = {}, set = {} }) {
    if (to) assertOpportunityTransition(opportunity.state, to);
    const columns = { ...set, ...(to ? { state: to } : {}) };
    const assignments = Object.keys(columns).map((c) => `${c} = ?`);
    const values = Object.values(columns).map((v) => (v !== null && typeof v === "object" ? JSON.stringify(v) : v));
    const result = this.#reg.db.prepare(`UPDATE opportunities SET ${[...assignments, "version = version + 1", "updated_at = ?"].join(", ")}
      WHERE tenant_id = ? AND id = ? AND version = ?`).run(...values, this.#reg.now(), tenantId, opportunity.id, opportunity.version);
    if (result.changes !== 1) throw new InnovationError("CONCURRENT_UPDATE", "The opportunity changed while this operation ran; reload and retry.");
    this.#event(tenantId, opportunity.id, type, actor, { from: opportunity.state, to: to ?? opportunity.state, payload });
    return this.get(tenantId, opportunity.id);
  }

  events(tenantId, id) {
    requireTenant(tenantId);
    return this.#reg.db.prepare("SELECT * FROM opportunity_events WHERE tenant_id = ? AND opportunity_id = ? ORDER BY seq").all(tenantId, id)
      .map((r) => ({ type: r.type, actor: r.actor, from: r.from_state, to: r.to_state, payload: JSON.parse(r.payload), at: r.at }));
  }

  reviews(tenantId, id, round = undefined) {
    requireTenant(tenantId);
    return this.#reg.db.prepare("SELECT * FROM opportunity_reviews WHERE tenant_id = ? AND opportunity_id = ? ORDER BY round, at, rowid").all(tenantId, id)
      .filter((r) => round === undefined || r.round === round)
      .map((r) => ({ round: r.round, agentId: r.agent_id, seat: r.seat, ...JSON.parse(r.review_json), at: r.at }));
  }

  measurements(tenantId, id) {
    requireTenant(tenantId);
    return this.#reg.db.prepare("SELECT * FROM opportunity_measurements WHERE tenant_id = ? AND opportunity_id = ? ORDER BY seq").all(tenantId, id)
      .map((r) => ({ metric: r.metric, before: r.before_value, after: r.after_value, source: r.source, recordedBy: r.recorded_by, at: r.at }));
  }

  lessons(tenantId, id) {
    requireTenant(tenantId);
    return this.#reg.db.prepare("SELECT * FROM opportunity_lessons WHERE tenant_id = ? AND opportunity_id = ? ORDER BY seq").all(tenantId, id)
      .map((r) => ({ lesson: r.lesson, recordedBy: r.recorded_by, at: r.at }));
  }

  // -------------------------------------------------------------------------
  // Authority
  // -------------------------------------------------------------------------

  #requireAgent(tenantId, agentId, permission) {
    requireText(agentId, "agentId", 128);
    const agent = this.#reg.getAgent(tenantId, agentId);
    if (!agent || !this.#reg.isLive(agent)) {
      throw new InnovationError("AGENT_NOT_ACTIVE", `Agent '${agentId}' is not an active agent in this tenant.`);
    }
    const needed = Array.isArray(permission) ? permission : [permission];
    if (!needed.some((p) => permissionsCover(agent.permissions, p))) {
      throw new InnovationError("MISSING_PERMISSION", `${agent.name ?? agent.id} does not hold ${needed.join(" or ")}.`, { agentId, needed });
    }
    return agent;
  }

  /** Build and launch decisions belong to people. An agent id is never accepted here. */
  #requireHuman(tenantId, decidedBy) {
    if (!decidedBy || decidedBy.kind !== "human" || typeof decidedBy.id !== "string" || !decidedBy.id.trim() || decidedBy.id.length > 200) {
      throw new InnovationError("HUMAN_DECISION_REQUIRED", "This decision must be made by a human principal ({ kind: 'human', id }).");
    }
    if (this.#reg.getAgent(tenantId, decidedBy.id)) {
      throw new InnovationError("AGENT_CANNOT_APPROVE", "Agents cannot approve builds or launches, including their own proposals.");
    }
    return { kind: "human", id: decidedBy.id.trim() };
  }

  // -------------------------------------------------------------------------
  // Opportunity Memory
  // -------------------------------------------------------------------------

  /** Everything Atlas already knows about ideas like this one, most similar first. */
  searchMemory(tenantId, query, { limit = 10, threshold = this.#policy.relatedThreshold } = {}) {
    requireTenant(tenantId);
    // A brief is compared symmetrically (duplicate detection); a typed search
    // asks how much of the query an opportunity covers.
    const freeText = typeof query === "string";
    const tokens = tokenize(freeText ? query : briefFingerprintText(query));
    const score = freeText ? coverage : jaccard;
    return this.#reg.db.prepare("SELECT * FROM opportunities WHERE tenant_id = ?").all(tenantId)
      .map((row) => this.#hydrate(row))
      .map((o) => ({ o, similarity: score(tokens, tokenize(briefFingerprintText(o.brief))) }))
      .filter(({ similarity }) => similarity >= threshold)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, Math.max(1, Math.min(limit, 50)))
      .map(({ o, similarity }) => ({
        id: o.id,
        title: o.title,
        state: o.state,
        similarity: Math.round(similarity * 1000) / 1000,
        rejectionReason: o.rejectionReason,
        outcome: o.outcome,
        lessons: this.lessons(tenantId, o.id).map((l) => l.lesson),
      }));
  }

  // -------------------------------------------------------------------------
  // Discover
  // -------------------------------------------------------------------------

  /**
   * The BDE submits an evidence-backed brief. Opportunity Memory is checked
   * first: a near-duplicate of anything already known is refused with the
   * matches, unless it names a closed idea it supersedes and brings evidence
   * that idea did not have.
   */
  submitOpportunity(tenantId, { agentId, brief: briefInput, supersedes = null }) {
    requireTenant(tenantId);
    this.#requireAgent(tenantId, agentId, INNOVATION_PERMISSIONS.propose);
    const brief = validateOpportunityBrief(briefInput);
    return this.#reg.transaction(() => {
      const related = this.searchMemory(tenantId, brief, { limit: 10 });
      const duplicates = related.filter((m) => m.similarity >= this.#policy.duplicateThreshold && m.id !== supersedes);
      if (duplicates.length) {
        throw new InnovationError("DUPLICATE_OPPORTUNITY",
          `Opportunity Memory already holds ${duplicates.length} similar idea(s); the closest is '${duplicates[0].title}' (${duplicates[0].state}).`,
          { matches: duplicates });
      }
      if (supersedes) {
        const previous = this.#require(tenantId, supersedes);
        if (ACTIVE_STATES.includes(previous.state) && previous.state !== "ITERATE") {
          throw new InnovationError("SUPERSEDES_ACTIVE", `'${previous.title}' is still ${previous.state}; revise it instead of resubmitting.`);
        }
        const oldSources = new Set(previous.brief.evidence.map((e) => e.source));
        if (!brief.evidence.some((e) => !oldSources.has(e.source))) {
          throw new InnovationError("NO_NEW_EVIDENCE", `Resubmitting '${previous.title}' requires evidence it did not already have.`);
        }
      }
      const id = newOpportunityId();
      const at = this.#reg.now();
      this.#reg.db.prepare(`INSERT INTO opportunities (tenant_id, id, title, state, correlation_id, submitted_by, supersedes, brief_json, created_at, updated_at)
        VALUES (?, ?, ?, 'DISCOVERED', ?, ?, ?, ?, ?, ?)`)
        .run(tenantId, id, brief.title, newCorrelationId(), agentId, supersedes, JSON.stringify(brief), at, at);
      this.#event(tenantId, id, "opportunity.discovered", agentId, { to: "DISCOVERED", payload: { related: related.map((r) => ({ id: r.id, similarity: r.similarity })), supersedes } });
      return { opportunity: this.get(tenantId, id), related };
    });
  }

  // -------------------------------------------------------------------------
  // Research and validation
  // -------------------------------------------------------------------------

  startResearch(tenantId, id, { agentId, questions = [] }) {
    this.#requireAgent(tenantId, agentId, [INNOVATION_PERMISSIONS.research, INNOVATION_PERMISSIONS.review, INNOVATION_PERMISSIONS.propose]);
    const opportunity = this.#require(tenantId, id);
    return this.#reg.transaction(() => this.#update(tenantId, opportunity, {
      to: "RESEARCHING", actor: agentId, type: "opportunity.research_requested",
      payload: { questions: textList(questions, "questions", { max: 20 }) },
    }));
  }

  /**
   * An independent researcher records whether the brief's assumptions hold.
   * Unsupported assumptions reject the opportunity, and the reason is kept in
   * memory so the idea is not rediscovered without new evidence.
   */
  recordResearch(tenantId, id, { agentId, supported, findings, sources = [] }) {
    this.#requireAgent(tenantId, agentId, INNOVATION_PERMISSIONS.research);
    const opportunity = this.#require(tenantId, id);
    if (agentId === opportunity.submittedBy) throw new InnovationError("RESEARCH_NOT_INDEPENDENT", "The submitter cannot validate its own brief.");
    if (typeof supported !== "boolean") throw new InnovationError("INVALID_ARGUMENT", "'supported' must be true or false.");
    const research = {
      supported,
      findings: textList(findings, "findings", { min: 1, max: 20 }),
      sources: textList(sources, "sources", { min: supported ? 1 : 0, max: 30 }),
      researchedBy: agentId,
      at: this.#reg.now(),
    };
    return this.#reg.transaction(() => this.#update(tenantId, opportunity, {
      to: supported ? "VALIDATED" : "REJECTED",
      actor: agentId,
      type: supported ? "opportunity.validated" : "opportunity.rejected",
      payload: { research },
      set: { research_json: research, ...(supported ? {} : { rejection_reason: `Research did not support the assumption: ${research.findings[0]}` }) },
    }));
  }

  // -------------------------------------------------------------------------
  // Product review → Implementation Proposal
  // -------------------------------------------------------------------------

  /**
   * The Product Executive turns a validated opportunity into an Implementation
   * Proposal, sends it back for more research, or rejects it. It cannot
   * approve the build.
   */
  productReview(tenantId, id, { agentId, decision, proposal = null, reason = null, questions = [] }) {
    this.#requireAgent(tenantId, agentId, INNOVATION_PERMISSIONS.review);
    const opportunity = this.#require(tenantId, id);
    if (agentId === opportunity.submittedBy) throw new InnovationError("REVIEW_NOT_INDEPENDENT", "The submitter cannot product-review its own brief.");
    const revising = opportunity.state === "PROPOSED" || opportunity.state === "ITERATE";
    if (!["VALIDATED", "PROPOSED", "ITERATE"].includes(opportunity.state)) {
      throw new InnovationError("ILLEGAL_OPPORTUNITY_TRANSITION", `A product review needs a validated opportunity (is '${opportunity.state}').`);
    }
    return this.#reg.transaction(() => {
      if (decision === "needs_research") {
        return this.#update(tenantId, opportunity, { to: "RESEARCHING", actor: agentId, type: "opportunity.research_requested", payload: { questions: textList(questions, "questions", { min: 1 }) } });
      }
      if (decision === "reject") {
        const why = requireText(reason, "reason", 2000);
        return this.#update(tenantId, opportunity, { to: "REJECTED", actor: agentId, type: "opportunity.rejected", payload: { reason: why }, set: { rejection_reason: why } });
      }
      if (decision !== "propose") throw new InnovationError("INVALID_ARGUMENT", "decision must be 'propose', 'needs_research' or 'reject'.");
      const normalized = validateImplementationProposal(proposal);
      // A round that has not convened yet (e.g. right after "modify") is reused.
      const round = opportunity.council && !opportunity.council.roster ? opportunity.council.round : (opportunity.council?.round ?? 0) + 1;
      return this.#update(tenantId, opportunity, {
        to: opportunity.state === "PROPOSED" ? null : "PROPOSED",
        actor: agentId,
        type: revising ? "opportunity.proposal_revised" : "opportunity.proposed",
        payload: { round, estimatedEffort: normalized.estimatedEffort },
        // A new or revised proposal invalidates any earlier packet and council round.
        set: { proposal_json: normalized, council_json: { round, roster: null, proposedBy: agentId }, packet_json: null, packet_digest: null, approval_id: null },
      });
    });
  }

  // -------------------------------------------------------------------------
  // Council → Decision Packet
  // -------------------------------------------------------------------------

  #needsCouncil(opportunity) {
    const effort = opportunity.proposal?.estimatedEffort ?? opportunity.brief.estimatedEffort;
    return this.#policy.councilEfforts.includes(effort);
  }

  #findSeat(tenantId, seat) {
    return this.#reg.listAgents(tenantId, { state: ["authorized", "idle", "running"] })
      .find((a) => a.role === seat.role && (!seat.family || a.family === seat.family)) ?? null;
  }

  /**
   * Assembles the temporary review council for this proposal round. Small
   * proposals seat only Security when the brief names a security risk;
   * substantial ones seat every specialty the organization has. Missing seats
   * are reported rather than silently skipped.
   */
  convene(tenantId, id, { agentId }) {
    this.#requireAgent(tenantId, agentId, INNOVATION_PERMISSIONS.review);
    const opportunity = this.#require(tenantId, id);
    if (opportunity.state !== "PROPOSED") throw new InnovationError("ILLEGAL_OPPORTUNITY_TRANSITION", `A council needs a proposed opportunity (is '${opportunity.state}').`);
    const hasSecurityRisk = opportunity.brief.risks.some((r) => r.category === "security");
    const seats = this.#needsCouncil(opportunity)
      ? COUNCIL_SEATS
      : COUNCIL_SEATS.filter((s) => s.role === "security" && hasSecurityRisk);
    const roster = [];
    const vacant = [];
    for (const seat of seats) {
      const agent = this.#findSeat(tenantId, seat);
      if (agent && permissionsCover(agent.permissions, INNOVATION_PERMISSIONS.council)) roster.push({ seat: seat.seat, agentId: agent.id, name: agent.name ?? agent.id });
      else vacant.push(seat.seat);
    }
    return this.#reg.transaction(() => {
      const round = opportunity.council?.round ?? 1;
      const updated = this.#update(tenantId, opportunity, {
        actor: agentId, type: "opportunity.council_convened", payload: { round, roster, vacant },
        set: { council_json: { round, roster, vacant, convenedBy: agentId } },
      });
      for (const member of roster) {
        if (member.agentId === agentId) continue;
        this.#delegation.bus.sendMessage({
          tenantId, type: "REVIEW_REQUEST", source: agentId, destination: member.agentId, taskId: id,
          correlationId: opportunity.correlationId, payload: { opportunityId: id, round, seat: member.seat, title: opportunity.title },
        });
      }
      return updated;
    });
  }

  submitCouncilReview(tenantId, id, { agentId, review }) {
    this.#requireAgent(tenantId, agentId, INNOVATION_PERMISSIONS.council);
    const opportunity = this.#require(tenantId, id);
    if (opportunity.state !== "PROPOSED" || !opportunity.council?.roster) {
      throw new InnovationError("COUNCIL_NOT_CONVENED", "This proposal has no open council round.");
    }
    const member = opportunity.council.roster.find((m) => m.agentId === agentId);
    if (!member) throw new InnovationError("NOT_A_COUNCIL_MEMBER", "Only seated council members may review this round.");
    const normalized = validateCouncilReview(review);
    const round = opportunity.council.round;
    return this.#reg.transaction(() => {
      const existing = this.#reg.db.prepare("SELECT 1 FROM opportunity_reviews WHERE tenant_id = ? AND opportunity_id = ? AND round = ? AND agent_id = ?").get(tenantId, id, round, agentId);
      if (existing) throw new InnovationError("ALREADY_REVIEWED", "This member already reviewed this round.");
      this.#reg.db.prepare("INSERT INTO opportunity_reviews (tenant_id, opportunity_id, round, agent_id, seat, review_json, at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(tenantId, id, round, agentId, member.seat, JSON.stringify(normalized), this.#reg.now());
      this.#event(tenantId, id, "opportunity.council_review", agentId, { from: opportunity.state, to: opportunity.state, payload: { round, seat: member.seat, stance: normalized.stance } });
      const convener = opportunity.council.convenedBy;
      if (convener && convener !== agentId) {
        this.#delegation.bus.sendMessage({
          tenantId, type: "REVIEW_RESULT", source: agentId, destination: convener, taskId: id,
          correlationId: opportunity.correlationId, payload: { opportunityId: id, round, seat: member.seat, stance: normalized.stance },
        });
      }
      return this.reviews(tenantId, id, round);
    });
  }

  /**
   * Builds the Decision Packet once every seated member has spoken. Dissent is
   * reported, never averaged away. The packet's digest is what a human
   * approves; the approval request is raised here unless policy allows a
   * low-risk build to proceed without one.
   */
  finalizeDecisionPacket(tenantId, id, { agentId }) {
    this.#requireAgent(tenantId, agentId, INNOVATION_PERMISSIONS.review);
    const opportunity = this.#require(tenantId, id);
    if (opportunity.state !== "PROPOSED" || !opportunity.proposal) throw new InnovationError("ILLEGAL_OPPORTUNITY_TRANSITION", "A Decision Packet needs a proposed opportunity with an Implementation Proposal.");
    if (!opportunity.council?.roster) throw new InnovationError("COUNCIL_NOT_CONVENED", "Convene the council (it may be empty for small proposals) before finalizing.");
    const round = opportunity.council.round;
    const reviews = this.reviews(tenantId, id, round);
    const missing = opportunity.council.roster.filter((m) => !reviews.some((r) => r.agentId === m.agentId)).map((m) => m.seat);
    if (missing.length) throw new InnovationError("COUNCIL_INCOMPLETE", `Waiting on: ${missing.join(", ")}.`, { missing });

    const byStance = (stance) => reviews.filter((r) => r.stance === stance).map((r) => r.seat);
    const disagreements = {
      supporting: byStance("support"),
      concerned: byStance("concerns"),
      opposing: byStance("oppose"),
      openConditions: reviews.flatMap((r) => r.conditions.map((c) => ({ seat: r.seat, condition: c }))),
    };
    const consensus = !reviews.length ? "no_council"
      : disagreements.opposing.length ? "contested"
        : disagreements.concerned.length ? "support_with_concerns" : "unanimous_support";
    const { brief, proposal } = opportunity;
    const packet = {
      schema: "atlas.decision_packet.v1",
      opportunityId: id,
      round,
      title: brief.title,
      opportunity: { problem: brief.problem, targetUser: brief.targetUser, valueHypothesis: brief.valueHypothesis, differentiation: brief.differentiation, originality: brief.originality },
      evidence: brief.evidence,
      research: opportunity.research,
      recommendedSpecification: { summary: proposal.summary, mvpScope: proposal.mvpScope, outOfScope: proposal.outOfScope, acceptanceCriteria: proposal.acceptanceCriteria, dependencies: proposal.dependencies },
      alternativesConsidered: proposal.alternativesConsidered,
      architectureImpact: proposal.architectureImpact,
      uxConcept: proposal.uxConcept,
      estimatedEffort: proposal.estimatedEffort,
      estimatedCost: brief.estimatedCost,
      risks: brief.risks,
      successMetrics: brief.successMetrics,
      confidence: brief.confidence,
      agentOpinions: reviews.map((r) => ({ seat: r.seat, agentId: r.agentId, stance: r.stance, summary: r.summary, findings: r.findings, conditions: r.conditions })),
      vacantSeats: opportunity.council.vacant ?? [],
      disagreements,
      consensus,
      implementationPlan: proposal.implementationPlan,
      commission: proposal.commission,
      policyVersion: this.#policy.version,
    };
    const packetDigest = digest(packet);
    const autoApprove = this.#policy.autoApproveEfforts.includes(proposal.estimatedEffort)
      && consensus !== "contested" && consensus !== "support_with_concerns"
      && !brief.risks.some((r) => ["security", "legal", "financial"].includes(r.category));

    return this.#reg.transaction(() => {
      let updated = this.#update(tenantId, opportunity, {
        to: "NEEDS_REVIEW", actor: agentId, type: "opportunity.decision_packet",
        payload: { round, packetDigest, consensus }, set: { packet_json: packet, packet_digest: packetDigest },
      });
      if (autoApprove) {
        const decision = { decision: "approve", decidedBy: { kind: "policy", id: this.#policy.version }, packetDigest, note: `Auto-approved: ${proposal.estimatedEffort} effort, unanimous council, no security, legal or financial risk.`, at: this.#reg.now() };
        updated = this.#update(tenantId, updated, { to: "APPROVED", actor: `policy:${this.#policy.version}`, type: "opportunity.approved", payload: decision, set: { decision_json: decision } });
      } else if (this.#approvals) {
        const approval = this.#approvals.request({
          tenantId, opportunityId: id, packetDigest,
          summary: `Atlas discovered a potential product improvement: ${brief.title} (${proposal.estimatedEffort}, ${consensus.replaceAll("_", " ")}).`,
        });
        updated = this.#update(tenantId, updated, { actor: agentId, type: "opportunity.approval_requested", payload: { approvalId: approval.id, packetDigest }, set: { approval_id: approval.id } });
      }
      return updated;
    });
  }

  // -------------------------------------------------------------------------
  // Human decision
  // -------------------------------------------------------------------------

  /**
   * Approve Build / Modify / Reject. Bound to the packet digest that was
   * shown to the person deciding; a stale digest is refused.
   */
  decide(tenantId, id, { decision, packetDigest, decidedBy, note = null }) {
    const human = this.#requireHuman(tenantId, decidedBy);
    const opportunity = this.#require(tenantId, id);
    if (opportunity.state !== "NEEDS_REVIEW") throw new InnovationError("ILLEGAL_OPPORTUNITY_TRANSITION", `Only an opportunity awaiting review can be decided (is '${opportunity.state}').`);
    if (packetDigest !== opportunity.packetDigest) {
      throw new InnovationError("STALE_DECISION_PACKET", "The Decision Packet changed since it was reviewed. Review the current packet before deciding.", { current: opportunity.packetDigest });
    }
    const record = { decision, decidedBy: human, packetDigest, note: note ? requireText(note, "note", 2000) : null, at: this.#reg.now() };
    return this.#reg.transaction(() => {
      let updated;
      if (decision === "approve") {
        updated = this.#update(tenantId, opportunity, { to: "APPROVED", actor: human.id, type: "opportunity.approved", payload: record, set: { decision_json: record } });
      } else if (decision === "modify") {
        if (!record.note) throw new InnovationError("INVALID_ARGUMENT", "Say what should change: a modification needs a note.");
        const round = (opportunity.council?.round ?? 1) + 1;
        updated = this.#update(tenantId, opportunity, {
          to: "PROPOSED", actor: human.id, type: "opportunity.modification_requested", payload: record,
          set: { decision_json: record, council_json: { round, roster: null, proposedBy: opportunity.council?.proposedBy ?? null }, packet_json: null, packet_digest: null, approval_id: null },
        });
      } else if (decision === "reject") {
        if (!record.note) throw new InnovationError("INVALID_ARGUMENT", "A rejection needs a reason; it is kept in Opportunity Memory.");
        updated = this.#update(tenantId, opportunity, { to: "REJECTED", actor: human.id, type: "opportunity.rejected", payload: record, set: { decision_json: record, rejection_reason: record.note } });
      } else {
        throw new InnovationError("INVALID_ARGUMENT", "decision must be 'approve', 'modify' or 'reject'.");
      }
      if (opportunity.approvalId && this.#approvals) this.#approvals.resolve({ tenantId, approvalId: opportunity.approvalId, approved: decision === "approve" });
      return updated;
    });
  }

  /** Called when the generic approvals inbox resolves an innovation approval. */
  decideFromApproval(tenantId, approvalId, { approved, decidedBy, actionDigest }) {
    requireTenant(tenantId);
    const row = this.#reg.db.prepare("SELECT id FROM opportunities WHERE tenant_id = ? AND approval_id = ?").get(tenantId, approvalId);
    if (!row) return null;
    return this.decide(tenantId, row.id, {
      decision: approved ? "approve" : "reject",
      packetDigest: actionDigest,
      decidedBy,
      note: approved ? null : "Rejected from the approvals inbox.",
    });
  }

  // -------------------------------------------------------------------------
  // Commission the build
  // -------------------------------------------------------------------------

  #peerParent(tenantId, family) {
    const peer = PEER_ORGANIZATIONS.find((p) => p.family === family);
    return this.#reg.listAgents(tenantId, { family, state: ["authorized", "idle", "running"] })
      .find((a) => a.name === peer?.parent) ?? this.#reg.listAgents(tenantId, { family, state: ["authorized", "idle", "running"] }).find((a) => a.role === "parent") ?? null;
  }

  /**
   * The Product Executive commissions the approved build: one canonical
   * platform task (the durable lifecycle every build shares) and one scoped
   * cross-family request per peer organization named in the proposal. Peers
   * receive the scope only — never a permission, token or secret.
   */
  commission(tenantId, id, { agentId, budget = { toolCalls: 400 } }) {
    this.#requireAgent(tenantId, agentId, INNOVATION_PERMISSIONS.commission);
    const opportunity = this.#require(tenantId, id);
    if (opportunity.state !== "APPROVED" || opportunity.decision?.decision !== "approve" || opportunity.decision.packetDigest !== opportunity.packetDigest) {
      throw new InnovationError("NOT_APPROVED", "Only an opportunity approved against its current Decision Packet can be built.");
    }
    const { proposal } = opportunity;
    const peers = proposal.commission.map((family) => ({ family, agent: this.#peerParent(tenantId, family) }));
    const unavailable = peers.filter((p) => !p.agent).map((p) => p.family);
    if (unavailable.length) throw new InnovationError("PEER_UNAVAILABLE", `No active organization for: ${unavailable.join(", ")}.`, { unavailable });

    const objective = `Build approved opportunity "${opportunity.title}": ${proposal.summary}`.slice(0, 8000);
    let platformTask = null;
    if (this.#platform) {
      platformTask = this.#platform.createTask({
        tenantId, userId: opportunity.decision.decidedBy.id, agentId, objective,
        successCriteria: proposal.acceptanceCriteria, budget, correlationId: opportunity.correlationId,
      });
      platformTask = this.#platform.transitionTask(tenantId, platformTask.id, "authorized", { actor: opportunity.decision.decidedBy.id, reason: `Decision Packet ${opportunity.packetDigest}` });
      platformTask = this.#platform.transitionTask(tenantId, platformTask.id, "queued", { actor: agentId, reason: "commissioned" });
    }
    try {
      return this.#reg.transaction(() => {
        const round = opportunity.council?.round ?? 1;
        const familyTaskId = `${id}:build:${round}`;
        this.#delegation.assignTask({
          tenantId, agentId, taskId: familyTaskId, correlationId: opportunity.correlationId,
          payload: { opportunityId: id, platformTaskId: platformTask?.id ?? null, packetDigest: opportunity.packetDigest },
        });
        const commissions = peers.map(({ family, agent }) => {
          const { requestId, assignment } = this.#delegation.requestCrossFamilyHelp({
            tenantId, fromAgentId: agentId, toAgentId: agent.id, taskId: familyTaskId, subtaskId: `${familyTaskId}:${family}`,
            correlationId: opportunity.correlationId,
            scope: {
              opportunityId: id, objective, mvpScope: proposal.mvpScope, outOfScope: proposal.outOfScope,
              acceptanceCriteria: proposal.acceptanceCriteria, affectedSystems: proposal.affectedSystems,
              packetDigest: opportunity.packetDigest, platformTaskId: platformTask?.id ?? null,
            },
          });
          return { family, agentId: agent.id, agentName: agent.name ?? agent.id, requestId, subtaskId: assignment.taskId };
        });
        this.#delegation.waitForSubtasks({ tenantId, taskId: familyTaskId, agentId, subtaskIds: commissions.map((c) => c.subtaskId) });
        const build = { familyTaskId, platformTaskId: platformTask?.id ?? null, commissionedBy: agentId, commissions, round, at: this.#reg.now() };
        return this.#update(tenantId, opportunity, { to: "BUILDING", actor: agentId, type: "opportunity.commissioned", payload: build, set: { build_json: build } });
      });
    } catch (error) {
      if (platformTask) this.#platform.transitionTask(tenantId, platformTask.id, "cancelled", { actor: agentId, reason: `Commissioning failed: ${error.code ?? "ERROR"}` });
      throw error;
    }
  }

  // -------------------------------------------------------------------------
  // Verify, launch, measure, learn
  // -------------------------------------------------------------------------

  #advancePlatform(tenantId, taskId, path, { actor, reason, result, error } = {}) {
    if (!this.#platform || !taskId) return;
    for (const to of path) {
      const task = this.#platform.getTask(tenantId, taskId);
      if (!task || task.status === to) continue;
      this.#platform.transitionTask(tenantId, taskId, to, { actor, reason, ...(to === "completed" ? { result } : {}), ...(to === "failed" ? { error } : {}) });
    }
  }

  /**
   * Records the verification of a build. Passing requires evidence beyond a
   * compile: at least one item that is not merely a build log. Failures send
   * the build back for repair until the repair budget is spent, then the
   * opportunity goes to ITERATE for a human rethink — never an endless loop.
   */
  recordVerification(tenantId, id, { agentId, passed, evidence = [] }) {
    this.#requireAgent(tenantId, agentId, PERMISSION_FOR_BUILD_VERIFICATION);
    let opportunity = this.#require(tenantId, id);
    if (!["BUILDING", "VERIFYING"].includes(opportunity.state)) throw new InnovationError("ILLEGAL_OPPORTUNITY_TRANSITION", `Nothing is being built (is '${opportunity.state}').`);
    if (typeof passed !== "boolean") throw new InnovationError("INVALID_ARGUMENT", "'passed' must be true or false.");
    if (!Array.isArray(evidence) || evidence.length > 50) throw new InnovationError("INVALID_ARGUMENT", "evidence must be a list of at most 50 items.");
    const items = evidence.map((e, i) => ({ kind: requireText(e?.kind, `evidence[${i}].kind`, 64), summary: requireText(e?.summary, `evidence[${i}].summary`, 2000), ref: e?.ref ? requireText(e.ref, `evidence[${i}].ref`, 1000) : null }));
    if (passed && !items.some((e) => e.kind !== "build")) {
      throw new InnovationError("INSUFFICIENT_EVIDENCE", "A build is not verified by compiling. Attach test, behavioral, visual or security evidence.");
    }
    const platformTaskId = opportunity.build?.platformTaskId;
    return this.#reg.transaction(() => {
      if (opportunity.state === "BUILDING") {
        opportunity = this.#update(tenantId, opportunity, { to: "VERIFYING", actor: agentId, type: "opportunity.verifying", payload: {} });
        this.#advancePlatform(tenantId, platformTaskId, ["running", "verifying"], { actor: agentId, reason: "verification started" });
      }
      if (passed) {
        this.#advancePlatform(tenantId, platformTaskId, ["completed"], { actor: agentId, reason: "verified", result: { evidence: items } });
        return this.#update(tenantId, opportunity, { to: "READY_TO_LAUNCH", actor: agentId, type: "opportunity.verified", payload: { evidence: items } });
      }
      const attempts = opportunity.repairAttempts + 1;
      if (attempts > this.#policy.maxRepairAttempts) {
        this.#advancePlatform(tenantId, platformTaskId, ["failed"], { actor: agentId, reason: "repair limit reached", error: { code: "REPAIR_LIMIT", message: "Verification kept failing." } });
        return this.#update(tenantId, opportunity, {
          to: "ITERATE", actor: agentId, type: "opportunity.escalated",
          payload: { evidence: items, attempts, reason: `Verification failed ${attempts} times; a person should decide whether to revise or archive.` },
          set: { repair_attempts: attempts },
        });
      }
      this.#advancePlatform(tenantId, platformTaskId, ["running"], { actor: agentId, reason: `repair attempt ${attempts}` });
      return this.#update(tenantId, opportunity, { to: "BUILDING", actor: agentId, type: "opportunity.repair", payload: { evidence: items, attempts }, set: { repair_attempts: attempts } });
    });
  }

  /** A person authorizes the launch of the verified build (deployment policy). */
  launch(tenantId, id, { decidedBy, packetDigest, note = null }) {
    const human = this.#requireHuman(tenantId, decidedBy);
    const opportunity = this.#require(tenantId, id);
    if (opportunity.state !== "READY_TO_LAUNCH") throw new InnovationError("ILLEGAL_OPPORTUNITY_TRANSITION", `Only a verified build can launch (is '${opportunity.state}').`);
    if (packetDigest !== opportunity.packetDigest) throw new InnovationError("STALE_DECISION_PACKET", "Launch approval must name the Decision Packet the build was approved against.");
    const launch = { decidedBy: human, packetDigest, note: note ? requireText(note, "note", 2000) : null, at: this.#reg.now() };
    return this.#reg.transaction(() => this.#update(tenantId, opportunity, { to: "LAUNCHED", actor: human.id, type: "opportunity.launched", payload: launch, set: { launch_json: launch } }));
  }

  recordMeasurement(tenantId, id, { agentId, metric, before = null, after, source }) {
    this.#requireAgent(tenantId, agentId, INNOVATION_PERMISSIONS.measure);
    const opportunity = this.#require(tenantId, id);
    if (!["LAUNCHED", "MEASURING"].includes(opportunity.state)) throw new InnovationError("ILLEGAL_OPPORTUNITY_TRANSITION", `Measure after launch (is '${opportunity.state}').`);
    const name = requireText(metric, "metric", 200);
    if (!opportunity.brief.successMetrics.some((m) => m.name === name)) {
      throw new InnovationError("UNKNOWN_METRIC", `'${name}' is not one of this opportunity's success metrics.`, { metrics: opportunity.brief.successMetrics.map((m) => m.name) });
    }
    const row = { before: before === null ? null : requireText(String(before), "before", 500), after: requireText(String(after ?? ""), "after", 500), source: requireText(source, "source", 1000) };
    return this.#reg.transaction(() => {
      this.#reg.db.prepare("INSERT INTO opportunity_measurements (tenant_id, opportunity_id, metric, before_value, after_value, source, recorded_by, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run(tenantId, id, name, row.before, row.after, row.source, agentId, this.#reg.now());
      return this.#update(tenantId, opportunity, {
        to: opportunity.state === "LAUNCHED" ? "MEASURING" : null, actor: agentId, type: "opportunity.measured", payload: { metric: name, ...row },
      });
    });
  }

  /** Closes the loop: did it matter, and what should Atlas remember? */
  conclude(tenantId, id, { agentId, outcome, summary, lessons }) {
    this.#requireAgent(tenantId, agentId, INNOVATION_PERMISSIONS.measure);
    const opportunity = this.#require(tenantId, id);
    if (opportunity.state !== "MEASURING") throw new InnovationError("ILLEGAL_OPPORTUNITY_TRANSITION", `Conclude after measuring (is '${opportunity.state}').`);
    if (!["successful", "iterate"].includes(outcome)) throw new InnovationError("INVALID_ARGUMENT", "outcome must be 'successful' or 'iterate'.");
    const learned = textList(lessons, "lessons", { min: 1, max: 20 });
    const record = { outcome, summary: requireText(summary, "summary", 4000), measurements: this.measurements(tenantId, id), at: this.#reg.now() };
    return this.#reg.transaction(() => {
      for (const lesson of learned) this.#addLesson(tenantId, id, lesson, agentId);
      return this.#update(tenantId, opportunity, { to: outcome === "successful" ? "SUCCESSFUL" : "ITERATE", actor: agentId, type: "opportunity.concluded", payload: record, set: { outcome_json: record } });
    });
  }

  #addLesson(tenantId, id, lesson, actor) {
    this.#reg.db.prepare("INSERT INTO opportunity_lessons (tenant_id, opportunity_id, lesson, recorded_by, at) VALUES (?, ?, ?, ?, ?)")
      .run(tenantId, id, lesson, actor, this.#reg.now());
  }

  recordLesson(tenantId, id, { actor, lesson }) {
    requireText(actor, "actor", 200);
    this.#require(tenantId, id);
    this.#addLesson(tenantId, id, requireText(lesson, "lesson", 2000), actor);
    return this.lessons(tenantId, id);
  }

  archive(tenantId, id, { actor, reason }) {
    requireText(actor, "actor", 200);
    const opportunity = this.#require(tenantId, id);
    const why = requireText(reason, "reason", 2000);
    return this.#reg.transaction(() => {
      if (opportunity.build?.familyTaskId && ["BUILDING", "APPROVED", "READY_TO_LAUNCH"].includes(opportunity.state)) {
        this.#delegation.cancelTask(tenantId, opportunity.build.familyTaskId, { reason: why });
        this.#advancePlatform(tenantId, opportunity.build.platformTaskId, ["cancelled"], { actor, reason: why });
      }
      return this.#update(tenantId, opportunity, { to: "ARCHIVED", actor, type: "opportunity.archived", payload: { reason: why }, set: opportunity.rejectionReason ? {} : { rejection_reason: opportunity.state === "SUCCESSFUL" ? null : why } });
    });
  }

  // -------------------------------------------------------------------------
  // Views
  // -------------------------------------------------------------------------

  #progress(tenantId, opportunity) {
    const build = opportunity.build;
    if (!build) return null;
    const subtasks = build.commissions.map((c) => {
      const a = this.#delegation.getAssignment(tenantId, c.subtaskId);
      return { family: c.family, agent: c.agentName, state: a?.state ?? "unknown", verified: Boolean(a?.verified) };
    });
    const platformTask = this.#platform && build.platformTaskId ? this.#platform.getTask(tenantId, build.platformTaskId) : null;
    return { subtasks, done: subtasks.filter((s) => s.state === "completed" && s.verified).length, total: subtasks.length, platformTask: platformTask ? { id: platformTask.id, status: platformTask.status } : null };
  }

  #card(tenantId, o) {
    const agentName = (agentId) => this.#reg.getAgent(tenantId, agentId)?.name ?? agentId;
    const assigned = new Set([o.submittedBy, o.research?.researchedBy, o.council?.proposedBy, ...(o.council?.roster ?? []).map((m) => m.agentId), ...(o.build?.commissions ?? []).map((c) => c.agentId)].filter(Boolean));
    return {
      id: o.id,
      title: o.title,
      state: o.state,
      valueHypothesis: o.brief.valueHypothesis,
      confidence: o.brief.confidence,
      evidence: { count: o.brief.evidence.length, strong: o.brief.evidence.filter((e) => e.strength === "strong").length, kinds: [...new Set(o.brief.evidence.map((e) => e.kind))] },
      estimatedEffort: o.proposal?.estimatedEffort ?? o.brief.estimatedEffort,
      dependencies: o.proposal?.dependencies ?? [],
      assignedAgents: [...assigned].map((agentId) => ({ agentId, name: agentName(agentId) })),
      progress: this.#progress(tenantId, o),
      results: o.outcome ? { outcome: o.outcome.outcome, summary: o.outcome.summary, measurements: o.outcome.measurements } : null,
      needsHuman: o.state === "NEEDS_REVIEW" || o.state === "READY_TO_LAUNCH" || o.state === "ITERATE",
      rejectionReason: o.rejectionReason,
      updatedAt: o.updatedAt,
    };
  }

  /** The Innovation Backlog: separate from engineering TODOs, newest activity first. */
  backlog(tenantId, { state } = {}) {
    requireTenant(tenantId);
    if (state && !OPPORTUNITY_STATES.includes(state)) throw new InnovationError("INVALID_ARGUMENT", `Unknown state '${state}'.`);
    return this.#reg.db.prepare("SELECT * FROM opportunities WHERE tenant_id = ? ORDER BY updated_at DESC, rowid DESC LIMIT 500").all(tenantId)
      .map((row) => this.#hydrate(row))
      .filter((o) => !state || o.state === state)
      .map((o) => this.#card(tenantId, o));
  }

  detail(tenantId, id) {
    const opportunity = this.#require(tenantId, id);
    return {
      opportunity,
      card: this.#card(tenantId, opportunity),
      events: this.events(tenantId, id),
      reviews: this.reviews(tenantId, id),
      measurements: this.measurements(tenantId, id),
      lessons: this.lessons(tenantId, id),
      related: this.searchMemory(tenantId, opportunity.brief, { limit: 6 }).filter((m) => m.id !== id),
    };
  }
}
