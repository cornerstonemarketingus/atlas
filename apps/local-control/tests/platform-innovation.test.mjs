import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AgentFamilyRegistry, MessageBus, seedFamilies } from "../src/platform/family/index.mjs";
import {
  InnovationError,
  InnovationPipeline,
  bootstrapInnovation,
  collectRepositorySignals,
  validateOpportunityBrief,
} from "../src/platform/innovation/index.mjs";
import { PlatformTaskStore } from "../src/platform/task-store.mjs";
import { createLocalControlServer } from "../src/server.mjs";
import { LocalTaskStore } from "../src/store.mjs";

const T = "tenant-a";
const OWNER = { kind: "human", id: "owner@example.test" };
const code = (c) => (error) => error instanceof InnovationError && error.code === c;

function brief(overrides = {}) {
  return {
    title: "Autonomous product optimization",
    problem: "Users generate an application with Atlas but cannot tell why visitors fail to convert, so they stop improving it.",
    targetUser: "Founders who launched a generated SaaS and have live traffic.",
    evidence: [
      { kind: "support_ticket", summary: "Twelve tickets in a month ask why sign-ups are low after launch.", source: "support://queue/conversion", strength: "strong" },
      { kind: "analytics", summary: "Median generated app loses 71% of visitors between landing and sign-up.", source: "analytics://funnels/generated-apps" },
    ],
    proposedSolution: "Instrument generated apps with funnel analytics, diagnose UX friction, and propose experiments for approval.",
    valueHypothesis: "Users who see a diagnosed funnel will run at least one improvement and keep their app alive longer.",
    differentiation: "Atlas already owns the source, so it can diagnose and change the real code rather than only report metrics.",
    implementationScope: ["analytics instrumentation", "funnel analysis", "experiment proposals"],
    estimatedEffort: "Medium",
    estimatedCost: { development: "Two to three weeks of agent time.", runtime: "Event storage for generated apps.", externalServices: "None." },
    risks: [
      { category: "security", description: "Analytics must not collect personal data without consent.", mitigation: "Aggregate-only events by default." },
      { category: "product", description: "Suggestions may be generic." },
    ],
    successMetrics: [
      { name: "experiment adoption", target: "30% of launched apps run one experiment", measurement: "experiments started / apps launched", baseline: "0%" },
    ],
    confidence: { level: "High", reasons: ["Consistent signal across tickets and funnels."] },
    ...overrides,
  };
}

function proposal(overrides = {}) {
  return {
    summary: "Funnel instrumentation plus a diagnosis report with approval-gated experiment proposals.",
    mvpScope: ["Landing→sign-up funnel events", "Diagnosis report", "One experiment proposal flow"],
    outOfScope: ["Multi-variant testing infrastructure"],
    acceptanceCriteria: ["A generated app emits funnel events", "The report names the largest drop-off with evidence"],
    dependencies: ["Generated app template exposes an analytics hook"],
    affectedSystems: ["apps/web", "generated app template"],
    alternativesConsidered: ["Link out to a third-party analytics product"],
    architectureImpact: "Adds an event ingestion route and a report job.",
    uxConcept: "A single Growth tab with one recommended next experiment.",
    implementationPlan: ["Add event hook", "Add ingestion", "Add report", "Add experiment proposal"],
    commission: ["engineering", "design"],
    estimatedEffort: "Medium",
    ...overrides,
  };
}

function harness({ policy = {}, filename = ":memory:" } = {}) {
  const registry = new AgentFamilyRegistry(filename);
  const { agents } = seedFamilies(registry, T);
  const dir = mkdtempSync(join(tmpdir(), "atlas-innovation-"));
  const platformStore = new PlatformTaskStore(join(dir, "platform.sqlite"));
  const requested = [];
  const resolved = [];
  const approvals = {
    request: (r) => { requested.push(r); return { id: `approval-${requested.length}` }; },
    resolve: (r) => { resolved.push(r); },
  };
  const pipeline = new InnovationPipeline({ registry, platformStore, approvals, policy });
  const cleanup = () => { platformStore.close(); registry.close(); rmSync(dir, { recursive: true, force: true }); };
  return { registry, pipeline, platformStore, agents, requested, resolved, cleanup };
}

/** Drives an opportunity to NEEDS_REVIEW with a full council; returns it. */
function toDecisionPacket(h, { stances = {}, briefOverrides = {}, proposalOverrides = {} } = {}) {
  const { pipeline, agents } = h;
  const { opportunity } = pipeline.submitOpportunity(T, { agentId: agents["Business Development Executive"], brief: brief(briefOverrides) });
  pipeline.recordResearch(T, opportunity.id, { agentId: agents["Market Research Agent"], supported: true, findings: ["Tickets and funnels agree."], sources: ["support://queue/conversion"] });
  pipeline.productReview(T, opportunity.id, { agentId: agents["Product Executive"], decision: "propose", proposal: proposal(proposalOverrides) });
  const convened = pipeline.convene(T, opportunity.id, { agentId: agents["Product Executive"] });
  for (const member of convened.council.roster) {
    const stance = stances[member.seat] ?? "support";
    pipeline.submitCouncilReview(T, opportunity.id, { agentId: member.agentId, review: { stance, summary: `${member.seat}: ${stance}.`, conditions: stance === "concerns" ? ["Aggregate-only analytics"] : [] } });
  }
  return pipeline.finalizeDecisionPacket(T, opportunity.id, { agentId: agents["Product Executive"] });
}

test("an Opportunity Brief without evidence, with unearned confidence, or copying a competitor is refused", () => {
  assert.throws(() => validateOpportunityBrief(brief({ evidence: [] })), code("INVALID_BRIEF"));
  assert.throws(() => validateOpportunityBrief(brief({ evidence: [{ kind: "analytics", summary: "x", strength: "strong" }] })), code("INVALID_BRIEF"));
  assert.throws(() => validateOpportunityBrief(brief({ evidence: [{ kind: "analytics", summary: "One weak hunch.", source: "note://1", strength: "weak" }] })), code("CONFIDENCE_NOT_SUPPORTED"));
  const competitor = [{ kind: "competitor", summary: "Another product offers a funnel view.", source: "https://example.test/pricing", strength: "moderate" }];
  assert.throws(() => validateOpportunityBrief(brief({ evidence: competitor, confidence: { level: "Low", reasons: ["One source."] } })), code("ORIGINALITY_REQUIRED"));
  const ok = validateOpportunityBrief(brief({ evidence: competitor, confidence: { level: "Low", reasons: ["One source."] }, originality: "Diagnosis runs against Atlas-owned source code; no UI or copy is reused." }));
  assert.equal(ok.evidence[0].kind, "competitor");
  assert.throws(() => validateOpportunityBrief(brief({ estimatedEffort: "Huge" })), code("INVALID_BRIEF"));
});

test("the closed loop: discover → validate → propose → council → human approval → build → verify → launch → measure → learn", () => {
  const h = harness();
  try {
    const { pipeline, agents, platformStore, requested, resolved } = h;
    const packetStage = toDecisionPacket(h, { stances: { Security: "concerns", "Finance / Cost": "oppose" } });
    assert.equal(packetStage.state, "NEEDS_REVIEW");
    const packet = packetStage.decisionPacket;
    // Nine seats, dissent reported rather than averaged away.
    assert.equal(packet.agentOpinions.length, 9);
    assert.equal(packet.consensus, "contested");
    assert.deepEqual(packet.disagreements.opposing, ["Finance / Cost"]);
    assert.deepEqual(packet.disagreements.concerned, ["Security"]);
    assert.deepEqual(packet.disagreements.openConditions, [{ seat: "Security", condition: "Aggregate-only analytics" }]);
    assert.equal(requested.length, 1);
    assert.equal(requested[0].packetDigest, packetStage.packetDigest);
    assert.match(requested[0].summary, /^Atlas discovered a potential product improvement/);
    // Council members were asked through typed messages.
    const bus = new MessageBus(h.registry);
    assert.equal(bus.listMessages(T, { taskId: packetStage.id, type: "REVIEW_REQUEST" }).length, 8);
    assert.equal(bus.listMessages(T, { taskId: packetStage.id, type: "REVIEW_RESULT" }).length, 8);

    // No agent can approve, a stale digest is refused, and nothing builds before approval.
    const id = packetStage.id;
    assert.throws(() => pipeline.commission(T, id, { agentId: agents["Product Executive"] }), code("NOT_APPROVED"));
    assert.throws(() => pipeline.decide(T, id, { decision: "approve", packetDigest: packetStage.packetDigest, decidedBy: { kind: "human", id: agents["Product Executive"] } }), code("AGENT_CANNOT_APPROVE"));
    assert.throws(() => pipeline.decide(T, id, { decision: "approve", packetDigest: packetStage.packetDigest, decidedBy: { kind: "agent", id: "x" } }), code("HUMAN_DECISION_REQUIRED"));
    assert.throws(() => pipeline.decide(T, id, { decision: "approve", packetDigest: "sha256:stale", decidedBy: OWNER }), code("STALE_DECISION_PACKET"));
    const approved = pipeline.decide(T, id, { decision: "approve", packetDigest: packetStage.packetDigest, decidedBy: OWNER });
    assert.equal(approved.state, "APPROVED");
    assert.deepEqual(resolved, [{ tenantId: T, approvalId: "approval-1", approved: true }]);

    // Commissioning: one canonical platform task, one scoped request per peer organization.
    assert.throws(() => pipeline.commission(T, id, { agentId: agents["Sales Agent"] }), code("MISSING_PERMISSION"));
    const building = pipeline.commission(T, id, { agentId: agents["Product Executive"] });
    assert.equal(building.state, "BUILDING");
    assert.deepEqual(building.build.commissions.map((c) => c.agentName), ["Engineering Parent", "Design Parent"]);
    const task = platformStore.getTask(T, building.build.platformTaskId);
    assert.equal(task.status, "queued");
    assert.equal(task.correlationId, building.correlationId);
    assert.deepEqual(task.successCriteria, proposal().acceptanceCriteria);
    assert.equal(pipeline.detail(T, id).card.progress.total, 2);

    // Compiling is not verification; failures go back for repair.
    const tester = agents["Testing Agent"];
    assert.throws(() => pipeline.recordVerification(T, id, { agentId: tester, passed: true, evidence: [{ kind: "build", summary: "tsc ok" }] }), code("INSUFFICIENT_EVIDENCE"));
    assert.throws(() => pipeline.recordVerification(T, id, { agentId: agents["Marketing Agent"], passed: true, evidence: [{ kind: "e2e", summary: "x" }] }), code("MISSING_PERMISSION"));
    assert.equal(pipeline.recordVerification(T, id, { agentId: tester, passed: false, evidence: [{ kind: "e2e", summary: "Sign-up event missing on mobile." }] }).state, "BUILDING");
    const verified = pipeline.recordVerification(T, id, { agentId: tester, passed: true, evidence: [{ kind: "e2e", summary: "Funnel events observed in a browser run.", ref: "artifact://run-2" }] });
    assert.equal(verified.state, "READY_TO_LAUNCH");
    assert.equal(platformStore.getTask(T, building.build.platformTaskId).status, "completed");

    // Launch is a human decision bound to the approved packet.
    assert.throws(() => pipeline.launch(T, id, { decidedBy: { kind: "human", id: agents["Deployment Agent"] }, packetDigest: packetStage.packetDigest }), code("AGENT_CANNOT_APPROVE"));
    assert.equal(pipeline.launch(T, id, { decidedBy: OWNER, packetDigest: packetStage.packetDigest }).state, "LAUNCHED");

    // Measure against the brief's own success metrics, then learn.
    assert.throws(() => pipeline.recordMeasurement(T, id, { agentId: agents["Analytics Agent"], metric: "vanity", after: "1", source: "x" }), code("UNKNOWN_METRIC"));
    assert.equal(pipeline.recordMeasurement(T, id, { agentId: agents["Analytics Agent"], metric: "experiment adoption", before: "0%", after: "34%", source: "analytics://experiments" }).state, "MEASURING");
    const done = pipeline.conclude(T, id, { agentId: agents["Business Development Executive"], outcome: "successful", summary: "Adoption beat target.", lessons: ["Diagnosis tied to real source changes gets adopted."] });
    assert.equal(done.state, "SUCCESSFUL");
    assert.equal(done.outcome.measurements[0].after, "34%");

    // Opportunity Memory: the idea is known, with its lesson, and cannot be rediscovered.
    const memory = pipeline.searchMemory(T, "optimize conversion funnel for generated applications");
    assert.equal(memory[0].id, id);
    assert.deepEqual(memory[0].lessons, ["Diagnosis tied to real source changes gets adopted."]);
    assert.throws(() => pipeline.submitOpportunity(T, { agentId: agents["Business Development Executive"], brief: brief() }), code("DUPLICATE_OPPORTUNITY"));
    const events = pipeline.events(T, id).map((e) => e.type);
    for (const type of ["opportunity.discovered", "opportunity.validated", "opportunity.proposed", "opportunity.council_convened", "opportunity.decision_packet", "opportunity.approval_requested", "opportunity.approved", "opportunity.commissioned", "opportunity.repair", "opportunity.verified", "opportunity.launched", "opportunity.measured", "opportunity.concluded"]) {
      assert.ok(events.includes(type), `missing ${type}`);
    }
    assert.throws(() => h.registry.db.prepare("DELETE FROM opportunity_events").run(), /append-only/);
  } finally {
    h.cleanup();
  }
});

test("research independence, rejection memory and resubmission with new evidence", () => {
  const h = harness();
  try {
    const { pipeline, agents } = h;
    const bde = agents["Business Development Executive"];
    assert.throws(() => pipeline.submitOpportunity(T, { agentId: agents["Sales Agent"], brief: brief() }), code("MISSING_PERMISSION"));
    const { opportunity } = pipeline.submitOpportunity(T, { agentId: bde, brief: brief() });
    // The BDE cannot validate or product-review its own idea.
    // The BDE holds its subtree's permissions, so independence is enforced separately from permission.
    assert.throws(() => pipeline.recordResearch(T, opportunity.id, { agentId: bde, supported: true, findings: ["yes"], sources: ["x"] }), code("RESEARCH_NOT_INDEPENDENT"));
    assert.throws(() => pipeline.productReview(T, opportunity.id, { agentId: agents["Product Executive"], decision: "propose", proposal: proposal() }), code("ILLEGAL_OPPORTUNITY_TRANSITION"));
    const rejected = pipeline.recordResearch(T, opportunity.id, { agentId: agents["Competitive Intelligence Agent"], supported: false, findings: ["The drop-off is caused by pricing, not UX."] });
    assert.equal(rejected.state, "REJECTED");
    assert.match(rejected.rejectionReason, /pricing, not UX/);

    const again = assert.throws(() => pipeline.submitOpportunity(T, { agentId: bde, brief: brief() }), (error) => {
      assert.equal(error.code, "DUPLICATE_OPPORTUNITY");
      assert.equal(error.details.matches[0].id, opportunity.id);
      assert.match(error.details.matches[0].rejectionReason, /pricing/);
      return true;
    });
    assert.equal(again, undefined);
    assert.throws(() => pipeline.submitOpportunity(T, { agentId: bde, brief: brief(), supersedes: opportunity.id }), code("NO_NEW_EVIDENCE"));
    const fresh = brief({ evidence: [...brief().evidence, { kind: "experiment_result", summary: "Pricing test fixed only 5% of the drop-off.", source: "experiment://pricing-1", strength: "strong" }] });
    const { opportunity: resubmitted } = pipeline.submitOpportunity(T, { agentId: bde, brief: fresh, supersedes: opportunity.id });
    assert.equal(resubmitted.supersedes, opportunity.id);
    assert.equal(pipeline.backlog(T, { state: "DISCOVERED" }).length, 1);
    assert.equal(pipeline.backlog(T).length, 2);
  } finally {
    h.cleanup();
  }
});

test("modify reopens the proposal with a new round; small low-risk work may be policy-approved only when configured", () => {
  const h = harness();
  try {
    const { pipeline, agents } = h;
    const stage = toDecisionPacket(h);
    assert.equal(stage.decisionPacket.consensus, "unanimous_support");
    assert.throws(() => pipeline.decide(T, stage.id, { decision: "modify", packetDigest: stage.packetDigest, decidedBy: OWNER }), code("INVALID_ARGUMENT"));
    const modified = pipeline.decide(T, stage.id, { decision: "modify", packetDigest: stage.packetDigest, decidedBy: OWNER, note: "Drop design from the first build." });
    assert.equal(modified.state, "PROPOSED");
    assert.equal(modified.council.round, 2);
    assert.equal(modified.packetDigest, null);
    // Round-1 reviews do not count for round 2.
    pipeline.productReview(T, stage.id, { agentId: agents["Product Executive"], decision: "propose", proposal: proposal({ commission: ["engineering"] }) });
    assert.equal(h.pipeline.get(T, stage.id).council.round, 2);
    pipeline.convene(T, stage.id, { agentId: agents["Product Executive"] });
    assert.throws(() => pipeline.finalizeDecisionPacket(T, stage.id, { agentId: agents["Product Executive"] }), code("COUNCIL_INCOMPLETE"));
  } finally {
    h.cleanup();
  }

  const small = { estimatedEffort: "Small", risks: [{ category: "product", description: "Low impact." }] };
  const withoutPolicy = harness();
  try {
    const stage = toDecisionPacket(withoutPolicy, { briefOverrides: small, proposalOverrides: { estimatedEffort: "Small" } });
    assert.equal(stage.state, "NEEDS_REVIEW", "a person approves by default, even for small work");
    assert.equal(stage.decisionPacket.consensus, "no_council");
  } finally {
    withoutPolicy.cleanup();
  }
  const withPolicy = harness({ policy: { autoApproveEfforts: ["Small"] } });
  try {
    const stage = toDecisionPacket(withPolicy, { briefOverrides: small, proposalOverrides: { estimatedEffort: "Small" } });
    assert.equal(stage.state, "APPROVED");
    assert.equal(stage.decision.decidedBy.kind, "policy");
    assert.equal(withPolicy.requested.length, 0);
    // A security risk always goes to a person.
    const risky = toDecisionPacket(withPolicy, { briefOverrides: { ...small, title: "Harden session cookies for generated apps", problem: "Generated apps set session cookies without the secure attribute.", proposedSolution: "Set secure, httpOnly and sameSite on every generated session cookie.", risks: [{ category: "security", description: "Cookie changes can log users out." }] }, proposalOverrides: { estimatedEffort: "Small" } });
    assert.equal(risky.state, "NEEDS_REVIEW");
  } finally {
    withPolicy.cleanup();
  }
});

test("the repair loop is bounded and escalates to ITERATE", () => {
  const h = harness({ policy: { maxRepairAttempts: 1 } });
  try {
    const { pipeline, agents } = h;
    const stage = toDecisionPacket(h);
    pipeline.decide(T, stage.id, { decision: "approve", packetDigest: stage.packetDigest, decidedBy: OWNER });
    const building = pipeline.commission(T, stage.id, { agentId: agents["Product Executive"] });
    const fail = () => pipeline.recordVerification(T, stage.id, { agentId: agents["Testing Agent"], passed: false, evidence: [{ kind: "e2e", summary: "Still failing." }] });
    assert.equal(fail().state, "BUILDING");
    const escalated = fail();
    assert.equal(escalated.state, "ITERATE");
    assert.equal(h.platformStore.getTask(T, building.build.platformTaskId).status, "failed");
    assert.ok(pipeline.backlog(T).find((c) => c.id === stage.id).needsHuman);
    assert.equal(pipeline.archive(T, stage.id, { actor: "owner", reason: "Not worth another attempt." }).state, "ARCHIVED");
  } finally {
    h.cleanup();
  }
});

test("the backlog survives a restart", () => {
  const dir = mkdtempSync(join(tmpdir(), "atlas-innovation-persist-"));
  const file = join(dir, "org.sqlite");
  try {
    const h = harness({ filename: file });
    const stage = toDecisionPacket(h);
    h.platformStore.close();
    h.registry.close();
    const registry = new AgentFamilyRegistry(file);
    const reopened = new InnovationPipeline({ registry });
    const card = reopened.backlog(T)[0];
    assert.equal(card.id, stage.id);
    assert.equal(card.state, "NEEDS_REVIEW");
    assert.equal(reopened.get(T, stage.id).packetDigest, stage.packetDigest);
    assert.equal(reopened.backlog("tenant-b").length, 0);
    registry.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("repository signals cite file and line from tracked files only", () => {
  const dir = mkdtempSync(join(tmpdir(), "atlas-signals-"));
  try {
    execFileSync("git", ["init", "-q", dir]);
    writeFileSync(join(dir, "app.mjs"), "export const x = 1;\n// FIXME: retries are not bounded\n// TODO(ux) show an empty state\n");
    writeFileSync(join(dir, "untracked.mjs"), "// TODO: not tracked\n");
    execFileSync("git", ["-C", dir, "add", "app.mjs"]);
    const result = collectRepositorySignals(dir);
    assert.equal(result.signals.length, 2);
    assert.deepEqual(result.evidence.map((e) => e.source), ["app.mjs:2", "app.mjs:3"]);
    assert.equal(result.evidence[0].strength, "moderate");
    assert.ok(result.evidence.every((e) => e.kind === "repository_signal"));
    assert.throws(() => collectRepositorySignals(tmpdir()), (e) => e.code === "NOT_A_REPOSITORY");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const TOKEN = "0123456789abcdef0123456789abcdef";

test("HTTP: the backlog page, structured blocked reasons, and approval through the approvals inbox", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "atlas-innovation-http-"));
  const store = new LocalTaskStore(join(directory, "atlas.sqlite"));
  const platformStore = new PlatformTaskStore(join(directory, "platform.sqlite"));
  const innovation = bootstrapInnovation({ filename: join(directory, "organization.sqlite"), store, platformStore });
  const server = createLocalControlServer({ store, token: TOKEN, runTask: async () => ({ ok: true, message: "ok" }), platformStore, innovation });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    innovation.close();
    platformStore.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const headers = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
  const post = (path, body) => fetch(`${origin}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
  const get = (path) => fetch(`${origin}${path}`, { headers });
  const { agents } = innovation;

  const page = await fetch(`${origin}/innovation`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Innovation Backlog/);
  assert.equal((await fetch(`${origin}/innovation.js`)).status, 200);
  assert.equal((await fetch(`${origin}/v1/innovation/backlog`)).status, 401);

  const org = await (await get("/v1/innovation/organization")).json();
  assert.equal(org.organization.tree.children[0].name, "Business Development Executive");
  assert.deepEqual(org.organization.peers.map((p) => p.family), ["engineering", "design", "computer_operations", "research"]);

  const created = await post("/v1/innovation/opportunities", { agentId: agents["Business Development Executive"], brief: brief() });
  assert.equal(created.status, 200);
  const { opportunity } = await created.json();
  const duplicate = await post("/v1/innovation/opportunities", { agentId: agents["Business Development Executive"], brief: brief() });
  assert.equal(duplicate.status, 409);
  const blocked = await duplicate.json();
  assert.equal(blocked.blocked, "BLOCKED_BY_POLICY");
  assert.match(blocked.unblock, /supersedes/);
  const denied = await post("/v1/innovation/opportunities", { agentId: agents["Sales Agent"], brief: brief({ title: "Something else entirely", problem: "Invoices are hard to reconcile.", proposedSolution: "Reconcile invoices automatically." }) });
  assert.equal(denied.status, 403);
  assert.equal((await denied.json()).blocked, "BLOCKED_BY_PERMISSION");

  const id = opportunity.id;
  assert.equal((await post(`/v1/innovation/opportunities/${id}/research`, { agentId: agents["Market Research Agent"], supported: true, findings: ["Confirmed."], sources: ["support://queue"] })).status, 200);
  assert.equal((await post(`/v1/innovation/opportunities/${id}/product-review`, { agentId: agents["Product Executive"], decision: "propose", proposal: proposal() })).status, 200);
  const convened = await (await post(`/v1/innovation/opportunities/${id}/council`, { agentId: agents["Product Executive"] })).json();
  for (const member of convened.opportunity.council.roster) {
    assert.equal((await post(`/v1/innovation/opportunities/${id}/council-reviews`, { agentId: member.agentId, review: { stance: "support", summary: "Fine." } })).status, 200);
  }
  const packet = await (await post(`/v1/innovation/opportunities/${id}/packet`, { agentId: agents["Product Executive"] })).json();
  assert.equal(packet.opportunity.state, "NEEDS_REVIEW");

  // The decision surfaces in the ordinary approvals inbox, bound to the packet digest.
  const { approvals } = await (await get("/v1/approvals")).json();
  const approval = approvals.find((a) => a.capability === "innovation.build");
  assert.ok(approval);
  assert.equal(approval.actionDigest, packet.opportunity.packetDigest);
  assert.match(approval.summary, /Atlas discovered a potential product improvement/);
  const decided = await post(`/v1/approvals/${approval.id}/decision`, { decision: "approved" });
  assert.equal(decided.status, 200);
  assert.equal((await decided.json()).approval.status, "approved");
  const detail = await (await get(`/v1/innovation/opportunities/${id}`)).json();
  assert.equal(detail.opportunity.state, "APPROVED");
  assert.equal(detail.opportunity.decision.decidedBy.id, "local-owner");

  const built = await (await post(`/v1/innovation/opportunities/${id}/commission`, { agentId: agents["Product Executive"] })).json();
  assert.equal(built.opportunity.state, "BUILDING");
  const tasks = await (await get("/v1/platform/tasks")).json();
  assert.equal(tasks.tasks[0].id, built.opportunity.build.platformTaskId);
  const backlog = await (await get("/v1/innovation/backlog?state=BUILDING")).json();
  assert.equal(backlog.opportunities.length, 1);
  assert.equal(backlog.opportunities[0].progress.total, 2);
  assert.equal((await get("/v1/innovation/backlog?state=NOPE")).status, 400);
});
