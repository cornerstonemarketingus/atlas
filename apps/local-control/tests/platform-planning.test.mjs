import assert from "node:assert/strict";
import test from "node:test";

import { AgentFamilyRegistry } from "../src/platform/family/index.mjs";
import { ModelCapabilityRegistry } from "../src/platform/models/capabilities.mjs";
import { comparePlans } from "../src/platform/planning/cost-aware.mjs";
import { runDesignDebate } from "../src/platform/planning/debate.mjs";
import { PerformanceError, PerformanceStore } from "../src/platform/planning/performance.mjs";
import { TeamSelector } from "../src/platform/planning/team-selection.mjs";

const T = "tenant-a";
const DAY = 86_400_000;
const NOW = new Date("2026-09-01T00:00:00Z");
const clock = () => NOW;
const ago = (days) => new Date(NOW.getTime() - days * DAY).toISOString();

// ---------------------------------------------------------------------------
// performance
// ---------------------------------------------------------------------------

test("only verified outcomes count as success; unverified claims score like failures", () => {
  const perf = new PerformanceStore(":memory:", { clock });
  for (let i = 0; i < 4; i += 1) perf.record({ tenantId: T, agentId: "a", taskKind: "extract", outcome: "verified", at: ago(1) });
  for (let i = 0; i < 4; i += 1) perf.record({ tenantId: T, agentId: "b", taskKind: "extract", outcome: "unverified", at: ago(1) });
  assert.equal(perf.score(T, { agentId: "a", taskKind: "extract" }).score, 1);
  const b = perf.score(T, { agentId: "b", taskKind: "extract" });
  assert.equal(b.score, 0);
  assert.equal(b.verified, 0);
  assert.throws(() => perf.record({ tenantId: T, agentId: "a", taskKind: "x", outcome: "success" }), (e) => e instanceof PerformanceError && e.code === "INVALID_OUTCOME");
});

test("minimum sample size: fewer results means no score", () => {
  const perf = new PerformanceStore(":memory:", { clock });
  perf.record({ tenantId: T, agentId: "a", taskKind: "k", outcome: "verified", at: ago(0) });
  perf.record({ tenantId: T, agentId: "a", taskKind: "k", outcome: "verified", at: ago(0) });
  const s = perf.score(T, { agentId: "a", taskKind: "k", minSamples: 3 });
  assert.equal(s.sufficient, false);
  assert.equal(s.score, null);
  assert.equal(s.observedRate, 1);
});

test("recency decay: recent results outweigh old ones", () => {
  const perf = new PerformanceStore(":memory:", { clock });
  for (let i = 0; i < 5; i += 1) perf.record({ tenantId: T, agentId: "a", taskKind: "k", outcome: "failed", at: ago(60), costMicroUsd: 100, durationMs: 10 });
  for (let i = 0; i < 5; i += 1) perf.record({ tenantId: T, agentId: "a", taskKind: "k", outcome: "verified", at: ago(0), costMicroUsd: 100, durationMs: 10 });
  const s = perf.score(T, { agentId: "a", taskKind: "k", halfLifeMs: 7 * DAY });
  assert.ok(s.score > 0.99, `score ${s.score}`);
  const flat = perf.score(T, { agentId: "a", taskKind: "k", halfLifeMs: 10_000 * DAY });
  assert.ok(Math.abs(flat.score - 0.5) < 0.01);
  assert.equal(s.meanCostMicroUsd, 100);
});

test("performance rows are tenant-isolated and append-only", () => {
  const perf = new PerformanceStore(":memory:", { clock });
  perf.record({ tenantId: T, agentId: "a", taskKind: "k", outcome: "verified" });
  assert.equal(perf.list("tenant-b").length, 0);
  assert.throws(() => perf.db.exec("UPDATE evaluation_results SET outcome = 'verified'"), /append-only/u);
});

// ---------------------------------------------------------------------------
// team selection
// ---------------------------------------------------------------------------

function family() {
  const registry = new AgentFamilyRegistry(":memory:", { clock });
  const spawn = (spec) => registry.spawnAgent({ tenantId: T, requestedBy: "owner", persistent: true, budget: {}, ...spec }, { authorizer: "policy" });
  const root = spawn({ parentId: null, role: "root", family: "atlas", permissions: ["repo.*", "web.*", "browser.*"] });
  const eng = spawn({ parentId: root.id, role: "parent", family: "engineering", permissions: ["repo.*"] });
  const fe1 = spawn({ parentId: eng.id, role: "frontend", family: "engineering", permissions: ["repo.read", "repo.write"] });
  const fe2 = spawn({ parentId: eng.id, role: "frontend", family: "engineering", permissions: ["repo.read", "repo.write"] });
  const tester = spawn({ parentId: eng.id, role: "testing", family: "engineering", permissions: ["repo.read"] });
  const research = spawn({ parentId: root.id, role: "web_research", family: "research", permissions: ["web.search"] });
  return { registry, root, eng, fe1, fe2, tester, research };
}

test("team selection prefers idle agents with the best verified performance and explains why", () => {
  const f = family();
  const perf = new PerformanceStore(":memory:", { clock });
  for (let i = 0; i < 3; i += 1) {
    perf.record({ tenantId: T, agentId: f.fe1.id, taskKind: "ui", outcome: i === 0 ? "failed" : "verified", at: ago(1) });
    perf.record({ tenantId: T, agentId: f.fe2.id, taskKind: "ui", outcome: "verified", at: ago(1) });
  }
  const selector = new TeamSelector({ registry: f.registry, performance: perf, now: NOW });
  const result = selector.select({
    tenantId: T, taskKind: "ui",
    slots: [
      { name: "builder", family: "engineering", requiredPermissions: ["repo.write"] },
      { name: "second builder", family: "engineering", requiredPermissions: ["repo.write"] },
      { name: "researcher", requiredPermissions: ["web.search"] },
    ],
  });
  assert.equal(result.complete, true);
  assert.equal(result.team[0].agentId, f.fe2.id);
  assert.equal(result.team[1].agentId, f.fe1.id, "one agent fills at most one slot");
  assert.equal(result.team[2].agentId, f.research.id);
  assert.match(result.explanation[0], /best verified score 1/u);
});

test("busy and poorly performing agents are not chosen; fallback is an unauthorized proposal", () => {
  const f = family();
  const perf = new PerformanceStore(":memory:", { clock });
  for (let i = 0; i < 3; i += 1) perf.record({ tenantId: T, agentId: f.fe1.id, taskKind: "ui", outcome: "failed", at: ago(1) });
  f.registry.markRunning(T, f.fe2.id, { actor: "t" });
  const selector = new TeamSelector({ registry: f.registry, performance: perf, now: NOW });
  const before = f.registry.listAgents(T).length;
  const dry = selector.select({ tenantId: T, taskKind: "ui", slots: [{ name: "builder", role: "frontend", family: "engineering", requiredPermissions: ["repo.write"] }] });
  assert.equal(dry.complete, false);
  assert.equal(dry.team.length, 0);
  assert.equal(dry.proposals[0].requiresAuthorization, true);
  assert.equal(dry.proposals[0].parentId, f.eng.id);
  assert.equal(dry.proposals[0].recorded, false);
  assert.match(dry.explanation[0], /busy/u);
  assert.match(dry.explanation[0], /below 0.5/u);
  assert.equal(f.registry.listAgents(T).length, before, "a dry proposal records nothing");

  const recorded = selector.select({ tenantId: T, taskKind: "ui", propose: true, requestedBy: "planner", slots: [{ name: "builder", role: "frontend", family: "engineering", requiredPermissions: ["repo.write"] }] });
  const agent = f.registry.getAgent(T, recorded.proposals[0].agentId);
  assert.equal(agent.state, "proposed", "the selector never authorizes");
  assert.equal(agent.authorizedBy, null);
});

test("no agent holds a permission → proposal under the root", () => {
  const f = family();
  const selector = new TeamSelector({ registry: f.registry });
  const r = selector.select({ tenantId: T, slots: [{ name: "navigator", requiredPermissions: ["browser.navigate"] }] });
  assert.equal(r.proposals[0].parentId, f.root.id);
  assert.deepEqual(r.proposals[0].permissions, ["browser.navigate"]);
});

// ---------------------------------------------------------------------------
// cost-aware planning
// ---------------------------------------------------------------------------

function models() {
  return new ModelCapabilityRegistry([
    { id: "cloud-big", provider: "anthropic", local: false, capabilities: { toolCalls: true, structuredOutput: true, vision: true, contextTokens: 200_000 }, costPerMTokIn: 3_000_000, costPerMTokOut: 15_000_000, reliability: 0.95, p50LatencyMs: 3000 },
    { id: "cloud-small", provider: "openai", local: false, capabilities: { toolCalls: true, structuredOutput: true, contextTokens: 128_000 }, costPerMTokIn: 150_000, costPerMTokOut: 600_000, reliability: 0.85, p50LatencyMs: 800 },
    { id: "local-small", provider: "ollama", local: true, endpoint: "http://127.0.0.1:11434", capabilities: { toolCalls: true, contextTokens: 32_000 }, costPerMTokIn: 0, costPerMTokOut: 0, reliability: 0.7, p50LatencyMs: 4000 },
  ]);
}

const plans = [
  { id: "big-model", steps: [{ tool: "browser.navigate" }, { complexity: "complex", needs: { toolCalls: true }, estimatedTokens: { in: 10_000, out: 2_000 } }] },
  { id: "small-model", steps: [{ tool: "browser.navigate" }, { complexity: "simple", needs: { toolCalls: true }, estimatedTokens: { in: 10_000, out: 2_000 } }, { complexity: "simple", estimatedTokens: { in: 2_000, out: 500 } }] },
  { id: "vision", steps: [{ tool: "desktop.screenshot", requiredCapabilities: ["desktop"] }, { complexity: "moderate", needs: { vision: true }, estimatedTokens: { in: 5_000, out: 500 } }] },
];

test("plans are priced with router pricing and ranked cheapest first", () => {
  const out = comparePlans({ plans, registry: models(), available: { tools: ["browser.navigate", "desktop.screenshot"], capabilities: ["desktop"] } });
  // big: 10k*3 + 2k*15 = 60,000 µUSD; small (simple picks local-small, free): 0.
  assert.equal(out.best, "small-model");
  assert.deepEqual(out.ranked.map((p) => p.id), ["small-model", "vision", "big-model"]);
  assert.equal(out.ranked.find((p) => p.id === "big-model").costMicroUsd, 60_000);
  assert.match(out.ranked[0].reasons[0], /cheapest feasible plan of 3/u);
  const latency = comparePlans({ plans, registry: models(), prefer: "latency" });
  // vision and big-model tie at 3500 ms; cost breaks the tie
  assert.deepEqual(latency.ranked.map((p) => p.id), ["vision", "big-model", "small-model"]);
});

test("plans needing unavailable capabilities or breaking constraints are rejected with reasons", () => {
  const out = comparePlans({
    plans, registry: models(),
    available: { tools: ["browser.navigate"], capabilities: [] },
    constraints: { privacy: "local_only", maxCostMicroUsd: 1_000 },
  });
  // local_only routes every model step to the local model, so both text plans stay feasible and free
  assert.deepEqual(out.ranked.map((p) => p.id).sort(), ["big-model", "small-model"]);
  assert.ok(out.ranked.every((p) => p.steps.every((s) => s.model === null || s.model === "local-small")));
  const vision = out.rejected.find((p) => p.id === "vision");
  assert.ok(vision.reasons.some((r) => /capability 'desktop' is not available/u.test(r)));
  assert.ok(vision.reasons.some((r) => /tool 'desktop.screenshot' is not available/u.test(r)));
  assert.ok(vision.reasons.some((r) => /no model qualifies/u.test(r)), "no local vision model");
  // under local_only, big-model's complex step is routed to the local model (cost 0), so it is feasible only on cost
  const budgetOnly = comparePlans({ plans: [plans[0]], registry: models(), constraints: { maxCostMicroUsd: 1_000 } });
  assert.equal(budgetOnly.best, null);
  assert.match(budgetOnly.rejected[0].reasons[0], /exceeds budget/u);
  assert.match(budgetOnly.reason, /no plan satisfies/u);
});

// ---------------------------------------------------------------------------
// debate
// ---------------------------------------------------------------------------

const tick = () => { let n = 0; return () => new Date(NOW.getTime() + (n++) * 1000); };

const criteria = [
  { id: "has-tests", kind: "hard", check: (p) => ({ pass: p.tests > 0, metrics: { tests: p.tests } }) },
  { id: "latency", kind: "soft", direction: "minimize", weight: 2, check: (p) => ({ value: p.latencyMs }) },
  { id: "coverage", kind: "soft", weight: 1, metric: "coverage", check: (p) => ({ metrics: { coverage: p.coverage } }) },
];

test("the debate winner passes all hard criteria and is best on weighted soft metrics — votes are ignored", async () => {
  const result = await runDesignDebate({
    question: "How should we cache results?",
    clock: tick(),
    proposers: [
      { id: "alpha", agentId: "agt-a", propose: () => ({ design: "lru", tests: 3, latencyMs: 10, coverage: 0.7 }) },
      { id: "beta", propose: () => ({ design: "none", tests: 0, latencyMs: 1, coverage: 1, votes: 99 }) },
      { id: "gamma", propose: () => ({ design: "ttl", tests: 2, latencyMs: 30, coverage: 0.9, votes: 50 }) },
    ],
    criteria,
  });
  assert.equal(result.status, "decided");
  assert.equal(result.winner.proposerId, "alpha");
  assert.equal(result.winner.agentId, "agt-a");
  const beta = result.scores.find((s) => s.proposerId === "beta");
  assert.equal(beta.passesHard, false);
  assert.deepEqual(beta.failedHard, ["has-tests"]);
  // provenance
  const proposal = result.transcript.find((e) => e.kind === "proposal" && e.proposerId === "alpha");
  assert.match(proposal.proposalDigest, /^sha256:/u);
  assert.ok(result.transcript.some((e) => e.kind === "evaluation" && e.criterionId === "latency" && e.proposerId === "gamma"));
  assert.equal(result.transcript.at(-1).kind, "decision");
  assert.equal(result.transcript.at(-1).basis, "executable-criteria");
  assert.deepEqual(result.transcript.map((e) => e.seq), result.transcript.map((_, i) => i + 1));
  assert.match(result.transcriptDigest, /^sha256:/u);
});

test("no proposal passing hard criteria, a throwing check, or a tie escalates", async () => {
  const none = await runDesignDebate({
    question: "q", clock: tick(), criteria,
    proposers: [{ id: "a", propose: () => ({ tests: 0, latencyMs: 1, coverage: 1 }) }, { id: "b", propose: () => { throw new Error("offline"); } }],
  });
  assert.equal(none.status, "escalated");
  assert.match(none.reason, /no proposal passed/u);
  assert.ok(none.transcript.some((e) => e.kind === "proposal.failed" && e.proposerId === "b"));

  const throwing = await runDesignDebate({
    question: "q", clock: tick(),
    criteria: [{ id: "safe", kind: "hard", check: () => { throw new Error("boom"); } }],
    proposers: [{ id: "a", propose: () => ({ x: 1 }) }],
  });
  assert.equal(throwing.status, "escalated");
  assert.equal(throwing.scores[0].results.safe.error, "boom");

  const tie = await runDesignDebate({
    question: "q", clock: tick(), criteria,
    proposers: [{ id: "a", propose: () => ({ tests: 1, latencyMs: 5, coverage: 0.5 }) }, { id: "b", propose: () => ({ tests: 4, latencyMs: 5, coverage: 0.5 }) }],
  });
  assert.equal(tie.status, "escalated");
  assert.deepEqual(tie.tied, ["a", "b"]);
});

test("debate validates criteria", async () => {
  await assert.rejects(runDesignDebate({ question: "q", proposers: [{ id: "a", propose: () => ({}) }], criteria: [{ id: "c", kind: "vote", check: () => true }] }), /hard' or 'soft/u);
  await assert.rejects(runDesignDebate({ question: "q", proposers: [{ id: "a", propose: () => ({}) }], criteria: [] }), /Explicit criteria/u);
});
