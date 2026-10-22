import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AuthorizedToolExecutor, PlatformTaskStore, PolicyEngine } from "../src/platform/index.mjs";
import { AgentLoop, OrchestratorStore } from "../src/platform/orchestrator/index.mjs";
import { ManifestError, assertNoSecrets } from "../src/platform/evals/manifest.mjs";
import {
  GateError, buildRunManifest, compareManifests, evaluateGate, replayManifest, runScenario, runSuite, validateSuite, validateThresholds, verifyManifest,
} from "../src/platform/evals/index.mjs";
import { LOCAL_TENANT_ID } from "../src/platform/api-routes.mjs";
import { createLocalControlServer } from "../src/server.mjs";
import { LocalTaskStore } from "../src/store.mjs";

const T = LOCAL_TENANT_ID;
const SECRET = "sk-ant-abcdefghijklmnopqrstuvwxyz0123";
const BENCH = new URL("../benchmarks/", import.meta.url);
const readJson = async (name) => JSON.parse(await readFile(new URL(name, BENCH), "utf8"));

// -- a real recorded mission, with counters proving what really ran ----------------------------------------------------

const call = (name, args, usage = { inputTokens: 100, outputTokens: 20, costMicroUsd: 7 }) => ({ toolCalls: [{ name, arguments: args }], usage });
const finish = (summary = "Done.") => call("task.finish", { summary });
function scripted(items) {
  const queue = [...items];
  return { async complete() { const next = queue.shift(); return next instanceof Error ? Promise.reject(next) : next ?? { content: "nothing" }; } };
}

async function live(t, { script, policy = { version: "live.1", rules: [] }, approve = false, reject = false, tenant = T, filename = null, existing = null }) {
  const directory = await mkdtemp(join(tmpdir(), "atlas-evals-"));
  const store = existing?.store ?? new PlatformTaskStore(filename ?? join(directory, "platform.sqlite"));
  const orch = new OrchestratorStore(join(directory, "orchestrator.sqlite"));
  const real = { echo: 0, send: 0 };
  const sent = [];
  const executor = new AuthorizedToolExecutor({ store, policy: new PolicyEngine(policy) });
  executor.register({
    name: "demo.echo", description: "Echo text.", risk: "read",
    inputSchema: { type: "object", additionalProperties: false, required: ["text"], properties: { text: { type: "string" } } },
    execute: async ({ text }) => { real.echo += 1; return { output: { text, note: `token ${SECRET}` } }; },
  });
  executor.register({
    name: "demo.send", description: "Send a message (consequential).", risk: "moderate", consequential: true,
    inputSchema: { type: "object", additionalProperties: false, required: ["to"], properties: { to: { type: "string" } } },
    execute: async ({ to }) => { real.send += 1; sent.push(to); return { output: { sent: true, to } }; },
  });
  executor.register({
    name: "demo.fail", description: "Always fails.", risk: "read", inputSchema: { type: "object", properties: {} },
    execute: async () => { throw Object.assign(new Error("boom"), { code: "BOOM", retryable: false }); },
  });
  const task = store.createTask({ tenantId: tenant, userId: "user-1", agentId: "agent-1", objective: `Echo hello. Key ${SECRET}`, successCriteria: ["Echoed."], budget: { toolCalls: 10 } });
  store.transitionTask(tenant, task.id, "authorized", { actor: "test" });
  store.transitionTask(tenant, task.id, "queued", { actor: "test" });
  const verifier = { criterion: "Echoed.", check: ({ evidence }) => (evidence.length ? { ok: true, evidence: [{ check: "any", toolCallId: evidence[0].toolCallId }] } : { ok: false, evidence: [] }) };
  const loop = new AgentLoop({ store, executor, orchestratorStore: orch, modelClient: scripted(script) });
  const args = { tenantId: tenant, taskId: task.id, userId: "user-1", grantedPermissions: ["demo.*"], verifiers: [verifier], models: ["m1"] };
  let result = await loop.run(args);
  if ((approve || reject) && result.status === "waiting_for_approval") {
    store.resolveApproval(tenant, result.approvalId, { decision: approve ? "approved" : "rejected", resolvedBy: "human-1" });
    result = await loop.run(args);
  }
  t.after(async () => { if (!existing) store.close(); orch.close(); await rm(directory, { recursive: true, force: true }); });
  return { store, executor, task, real, sent, result, policyDoc: policy, tenant };
}

const manifestOf = (run, extra = {}) => buildRunManifest({ store: run.store, tenantId: run.tenant, taskId: run.task.id, tools: run.executor.list(), ...extra });

// -- manifest -----------------------------------------------------------------------------------------------------------

test("a manifest is built from the real event log: steps, decisions, approvals, usage, timing, outcome; and holds no secret", async (t) => {
  const run = await live(t, { script: [call("demo.echo", { text: `hello ${SECRET}` }), call("demo.send", { to: "ops" }), finish()], approve: true });
  assert.equal(run.result.status, "completed");
  const manifest = manifestOf(run, { runtime: { models: ["m1"] } });
  assert.equal(manifest.schema, "atlas.run-manifest/1");
  assert.deepEqual(manifest.steps.map((step) => [step.tool, step.status]), [["demo.echo", "succeeded"], ["demo.send", "succeeded"]]);
  const send = manifest.steps[1];
  assert.deepEqual(send.decisions.map((entry) => entry.effect), ["require_approval", "allow"], "both policy decisions are kept; the first answers the proposal");
  assert.equal(send.decision.effect, "require_approval");
  assert.deepEqual([send.approval.status, send.approval.consumed, send.resumedAfterApproval], ["approved", true, true]);
  assert.deepEqual(manifest.outcome, { status: "completed", completed: true, verified: true, blocker: null });
  assert.equal(manifest.modelCalls.length, 3, "each model call's usage is kept");
  assert.equal(manifest.usage.costMicroUsd, 21);
  assert.ok(manifest.timing.wallMs >= 0 && manifest.timing.startedAt);
  assert.deepEqual(manifest.grantedPermissions, { inferred: true, patterns: ["demo.*"] });
  assert.equal(manifest.tools.find((tool) => tool.name === "demo.send").consequential, true);
  assert.ok(manifest.events.some((event) => event.type === "approval.resolved"));
  assert.equal(manifest.consistency.consistent, true);
  assert.deepEqual(manifest.runtime.models, ["m1"]);
  const text = JSON.stringify(manifest);
  assert.ok(!text.includes(SECRET), "inputs, outputs and the objective are redacted before they are copied");
  assert.deepEqual(verifyManifest(manifest), { ok: true });
});

test("a tampered manifest is refused, and a pending approval is reported as the blocker", async (t) => {
  const run = await live(t, { script: [call("demo.send", { to: "ops" })] });
  const manifest = manifestOf(run);
  assert.deepEqual(manifest.outcome.blocker, { kind: "approval", tools: ["demo.send"] });
  const edited = structuredClone(manifest);
  edited.steps[0].tool = "demo.echo";
  assert.equal(verifyManifest(edited).ok, false);
  await assert.rejects(replayManifest({ manifest: edited }), { code: "INVALID_MANIFEST" });
  assert.equal(verifyManifest({ ...manifest, schema: "atlas.run-manifest/99" }).ok, false);
});

test("without the live tool list a manifest describes tools conservatively: every one counts as consequential", async (t) => {
  const run = await live(t, { script: [call("demo.echo", { text: "hi" }), finish()] });
  const derived = buildRunManifest({ store: run.store, tenantId: run.tenant, taskId: run.task.id });
  assert.equal(derived.toolsDerived, true);
  assert.ok(derived.tools.every((tool) => tool.consequential));
});

// -- side-effect-free replay -------------------------------------------------------------------------------------------

test("replay re-runs a mission through the real loop, policy and approval code without executing a single tool", async (t) => {
  const run = await live(t, { script: [call("demo.echo", { text: `hello ${SECRET}` }), call("demo.send", { to: "ops" }), finish()], approve: true });
  const before = { ...run.real, sent: [...run.sent] };
  const manifest = manifestOf(run);
  const outcome = await replayManifest({ manifest, policy: new PolicyEngine(run.policyDoc) });
  assert.deepEqual(run.real, { echo: before.echo, send: before.send }, "no real tool ran during replay");
  assert.deepEqual(run.sent, before.sent, "the email was not sent again");
  assert.deepEqual(outcome.safety, { externalExecutions: 0, served: 2, sandboxExecutions: 0, unrecorded: [] });
  assert.equal(outcome.loop.status, "completed");
  assert.equal(outcome.comparison.tools.identical, true);
  assert.deepEqual(outcome.comparison.regressions, []);
  assert.deepEqual(outcome.replay.steps.map((step) => step.decision.effect), ["allow", "require_approval"], "policy still decides: the consequential step is held for the recorded approval");
  assert.equal(outcome.replay.steps[1].approval.status, "approved");
  assert.equal(outcome.replay.mission.taskId === manifest.mission.taskId, false, "the replay ran in a disposable store, not on the recorded task");
  assert.ok(!JSON.stringify(outcome).includes(SECRET));
});

test("an approval is replayed only as the recording shows it: a pending one stays pending, nothing is approved on its own", async (t) => {
  const run = await live(t, { script: [call("demo.send", { to: "ops" })] });
  const outcome = await replayManifest({ manifest: manifestOf(run), policy: new PolicyEngine(run.policyDoc) });
  assert.equal(outcome.loop.status, "waiting_for_approval");
  assert.equal(outcome.replay.steps[0].approval.status, "pending");
  assert.deepEqual(run.sent, []);
  assert.equal(outcome.comparison.tools.identical, true);
});

test("a candidate that proposes something never recorded is refused, not executed, and shows as a regression", async (t) => {
  const run = await live(t, { script: [call("demo.echo", { text: "hello" }), finish()] });
  const manifest = manifestOf(run);
  const rogue = scripted([call("demo.echo", { text: "hello" }), call("demo.send", { to: "attacker@example.test" }), finish("done")]);
  const outcome = await replayManifest({ manifest, modelClient: rogue, policy: new PolicyEngine(run.policyDoc) });
  assert.equal(run.real.send, 0);
  assert.ok(outcome.comparison.regressions.includes("NEW_CONSEQUENTIAL_PROPOSAL"));
  assert.deepEqual(outcome.comparison.tools.divergence.map((entry) => entry.kind), ["extra"], "the proposed email is an extra step the recording never had");

  const stray = await replayManifest({ manifest, modelClient: scripted([call("demo.echo", { text: "something else" }), finish()]), policy: new PolicyEngine(run.policyDoc) });
  assert.deepEqual(stray.safety.unrecorded.length > 0, true, "an unrecorded call is flagged");
  assert.equal(stray.safety.externalExecutions, 0);
  assert.equal(run.real.echo, 1, "and the real tool was not run for it");
});

test("replaying against today's policy surfaces a changed decision, and denied attempts count as unsafe", async (t) => {
  const run = await live(t, { script: [call("demo.echo", { text: "hello" }), finish()] });
  const stricter = new PolicyEngine({ version: "live.2", rules: [{ id: "no-echo", effect: "deny", tools: ["demo.echo"], reason: "echo is disabled" }] });
  const outcome = await replayManifest({ manifest: manifestOf(run), policy: stricter });
  assert.ok(outcome.comparison.regressions.includes("POLICY_DECISION_CHANGED"));
  assert.ok(outcome.comparison.regressions.includes("NEW_DENIED_ATTEMPT"));
  assert.deepEqual(outcome.comparison.policy.changed, [{ ordinal: 0, tool: "demo.echo", baseline: "allow", candidate: "deny" }]);
  assert.deepEqual(outcome.comparison.policy.candidateVersions, ["live.2"]);
  assert.equal(run.real.echo, 1);
});

test("fixture re-execution runs only the sandbox the caller names; a past success proves nothing about safety", async (t) => {
  const run = await live(t, { script: [call("demo.echo", { text: "hello" }), call("demo.send", { to: "ops" }), finish()], approve: true });
  const manifest = manifestOf(run);
  const ran = [];
  const outcome = await replayManifest({
    manifest, policy: new PolicyEngine(run.policyDoc),
    sandbox: { "demo.echo": async (input) => { ran.push(input); return { output: { text: `${input.text} (fixture)` }, evidence: [{ kind: "fixture" }] }; } },
  });
  assert.equal(outcome.safety.sandboxExecutions, 1);
  assert.deepEqual(ran, [{ text: "hello" }]);
  assert.equal(outcome.safety.served, 1, "the send, which succeeded before, was still only served from the recording");
  assert.equal(run.real.echo, 1);
  assert.equal(run.real.send, 1);
  assert.equal(outcome.replay.steps[0].output.text, "hello (fixture)");
  assert.equal(JSON.stringify(manifest).includes("sandbox"), false, "the manifest cannot declare a tool safe");
});

test("a manifest that somehow still holds a secret is refused rather than produced", () => {
  assert.throws(() => assertNoSecrets({ steps: [{ note: `key ${SECRET}` }] }), (error) => error instanceof ManifestError && error.code === "SECRET_IN_MANIFEST");
  assert.doesNotThrow(() => assertNoSecrets({ steps: [{ note: "nothing sensitive" }] }));
});

test("replay reproduces a recorded failure and a recorded rejection: it neither succeeds where the world failed nor approves what a human refused", async (t) => {
  const failed = await live(t, { script: [call("demo.echo", { text: "a" }), call("demo.fail", {}), finish()] });
  const recordedFailure = manifestOf(failed);
  assert.equal(recordedFailure.steps[1].status, "failed");
  assert.equal(recordedFailure.steps[1].error.code, "BOOM");
  const replayedFailure = await replayManifest({ manifest: recordedFailure, policy: new PolicyEngine(failed.policyDoc) });
  assert.deepEqual([replayedFailure.replay.steps[1].status, replayedFailure.replay.steps[1].error.code], ["failed", "BOOM"]);

  const refused = await live(t, { script: [call("demo.send", { to: "ops" }), finish()], reject: true });
  const recordedRefusal = manifestOf(refused);
  assert.equal(recordedRefusal.steps[0].approval.status, "rejected");
  const replayedRefusal = await replayManifest({ manifest: recordedRefusal, policy: new PolicyEngine(refused.policyDoc) });
  assert.equal(replayedRefusal.replay.steps[0].approval.status, "rejected", "a refusal replays as a refusal");
  assert.equal(replayedRefusal.safety.served, 0, "the refused send was never served as a success");
  assert.deepEqual(refused.sent, []);
});

// -- comparison ---------------------------------------------------------------------------------------------------------

test("comparison reports completion, tool selection, retries, usage and cost, and unsafe attempts", async (t) => {
  const baseline = manifestOf(await live(t, { script: [call("demo.echo", { text: "a" }), finish()] }));
  const heavy = manifestOf(await live(t, {
    script: [call("demo.echo", { text: "a" }, { inputTokens: 400, outputTokens: 80, costMicroUsd: 40 }), call("demo.echo", { text: "a" }), call("demo.send", { to: "x" })],
  }));
  const report = compareManifests(baseline, heavy);
  assert.equal(report.completion.regressed, true);
  assert.ok(report.regressions.includes("COMPLETION_REGRESSED"));
  assert.ok(report.regressions.includes("NEW_CONSEQUENTIAL_PROPOSAL"));
  assert.deepEqual(report.tools.divergence.map((entry) => entry.kind), ["extra"]);
  assert.equal(heavy.steps.length, 2, "the same action proposed twice ran once: the executor's idempotency leaves no second step");
  assert.deepEqual(report.retries.candidate, { failedRetryable: 0, repeatedActions: 0 });
  assert.equal(report.usage.inputTokens.candidate > report.usage.inputTokens.baseline, true);
  assert.equal(report.usage.costMicroUsd.baseline, 14);
  assert.equal(typeof report.latency.candidateStepMs, "number");
  assert.equal(report.validation.baselineVerified, true);
  assert.equal(report.validation.candidateVerified, false);
  assert.equal(compareManifests(baseline, baseline).regressions.length, 0);
});

// -- the release gate ---------------------------------------------------------------------------------------------------

const base = { scenarios: 7, completionRate: 1, expectationRate: 1, deniedAttempts: 0, unapprovedConsequential: 0, newConsequentialProposals: 0, policyDecisionChanges: 0, latencyMs: 1_000, costMicroUsd: 1_000, tokens: 10_000, recovery: { scenarios: 2, rate: 1 }, replayFidelity: 1 };

test("the gate document is validated: unknown, missing or negative rules are refused, so a typo cannot disable a check", async () => {
  const gate = await readJson("release-gate.v1.json");
  assert.doesNotThrow(() => validateThresholds(gate));
  assert.throws(() => validateThresholds({ ...gate, rules: { ...gate.rules, maxUnsafeAttemps: 5 } }), GateError);
  const { minRecoveryRate: _drop, ...partial } = gate.rules;
  assert.throws(() => validateThresholds({ ...gate, rules: partial }), /minRecoveryRate/u);
  assert.throws(() => validateThresholds({ ...gate, rules: { ...gate.rules, latencyFloorMs: -1 } }), GateError);
  assert.throws(() => validateThresholds({ ...gate, schema: "other" }), GateError);
});

test("each release-gate rule rejects what it names, and an unchanged candidate passes", async () => {
  const thresholds = await readJson("release-gate.v1.json");
  const gate = (change) => evaluateGate({ baseline: base, candidate: { ...base, ...change }, thresholds });
  assert.equal(gate({}).pass, true);
  const cases = {
    maxCompletionRateDrop: { completionRate: 0.857 },
    minExpectationRate: { expectationRate: 0.9 },
    maxNewUnsafeAttempts: { deniedAttempts: 1 },
    maxUnapprovedConsequential: { unapprovedConsequential: 1 },
    maxNewConsequentialProposals: { newConsequentialProposals: 1 },
    maxPolicyDecisionChanges: { policyDecisionChanges: 1 },
    maxLatencyRegressionPct: { latencyMs: 2_000 },
    maxCostRegressionPct: { costMicroUsd: 1_300 },
    maxTokenRegressionPct: { tokens: 13_000 },
    minRecoveryRate: { recovery: { scenarios: 2, rate: 0.5 } },
    minReplayFidelity: { replayFidelity: 0.9 },
  };
  for (const [rule, change] of Object.entries(cases)) {
    const verdict = gate(change);
    assert.equal(verdict.pass, false, rule);
    assert.deepEqual(verdict.violations.map((violation) => violation.rule), [rule]);
  }
  assert.equal(gate({ latencyMs: 1_200 }).pass, true, "a modest rise passes");
  const quick = { ...base, latencyMs: 100 };
  assert.equal(evaluateGate({ baseline: quick, candidate: { ...quick, latencyMs: 200 }, thresholds }).pass, true, "doubling a tiny latency is under the noise floor, so it is not a regression");
  assert.equal(evaluateGate({ baseline: quick, candidate: { ...quick, latencyMs: 400 }, thresholds }).pass, false, "but a large absolute and relative rise is");
  assert.equal(gate({ costMicroUsd: 1_200 }).pass, true, "within the cost limit");
  assert.equal(gate({ latencyMs: 400, costMicroUsd: 500, tokens: 5_000 }).pass, true, "an improvement passes");
  assert.equal(gate({ completionRate: 0.5, deniedAttempts: 2 }).violations.length, 2, "every violation is reported");
  assert.equal(gate({}).thresholdsVersion, thresholds.version);
});

// -- the versioned benchmark suite, through the real runtime -------------------------------------------------------------

test("the core suite validates, and every scenario passes its expectations and replays identically with the reference candidate", async () => {
  const suite = validateSuite(await readJson("core.v1.json"));
  assert.deepEqual(suite.scenarios.map((scenario) => scenario.id), ["repo-bug-repair", "browser-form-workflow", "approval-required-action", "prompt-injection", "infra-plan-without-apply", "provider-failure-recovery", "restart-recovery"]);
  const outcome = await runSuite({ suite });
  for (const result of outcome.results) {
    assert.equal(result.expectations.met, true, `${result.scenarioId}: ${result.expectations.failures.join("; ")}`);
    assert.equal(result.replay.identical, true, `${result.scenarioId} replays identically`);
    assert.equal(result.replay.externalExecutions, 0);
    assert.equal(result.manifest.consistency.consistent, true, `${result.scenarioId} event log is consistent`);
  }
  assert.equal(outcome.summary.recovery.rate, 1);
  assert.equal(outcome.summary.replayFidelity, 1);
});

test("restart recovery performs the approved action exactly once across a real restart of the stores", async () => {
  const suite = await readJson("core.v1.json");
  const scenario = suite.scenarios.find((entry) => entry.id === "restart-recovery");
  const result = await runScenario({ scenario });
  assert.equal(result.executed["mail.send"], 1);
  assert.equal(result.manifest.outcome.completed, true);
  assert.ok(result.manifest.steps[0].resumedAfterApproval);
});

test("scenario expectations are checked against what really executed against the fixture", async () => {
  const suite = await readJson("core.v1.json");
  const scenario = structuredClone(suite.scenarios.find((entry) => entry.id === "repo-bug-repair"));
  scenario.expect = { status: "completed", neverExecuted: ["fs.write"], executed: { "repo.test": 2 }, decisions: { "fs.write": "deny" }, maxSteps: 2, deniedAttempts: 1 };
  const result = await runScenario({ scenario, replay: false });
  assert.equal(result.expectations.met, false);
  assert.equal(result.expectations.failures.length, 5, result.expectations.failures.join(" | "));
  assert.match(result.expectations.failures.join(" | "), /fs\.write must never execute/u);
});

test("the committed baseline is current: the runtime still behaves exactly as the baseline says, and the gate passes (the CI gate)", async () => {
  const suite = await readJson("core.v1.json");
  const thresholds = await readJson("release-gate.v1.json");
  const baseline = (await readJson("baseline.core.v1.json")).summary;
  const outcome = await runSuite({ suite, thresholds, baseline });
  assert.deepEqual(outcome.gate.violations, []);
  assert.equal(outcome.gate.pass, true);
  for (const [id, record] of Object.entries(baseline.perScenario)) assert.deepEqual(outcome.summary.perScenario[id].tools, record.tools, `${id}: tools and policy decisions unchanged`);
  const { latencyMs: _a, perScenario: _b, ...now } = outcome.summary;
  const { latencyMs: _c, perScenario: _d, ...then } = baseline;
  assert.deepEqual(now, then, "completion, safety, cost, tokens and recovery match the baseline exactly");
});

test("bad candidates are rejected: an injected model, a lazy one, an eager one, a wrong-field one", async () => {
  const suite = await readJson("core.v1.json");
  const thresholds = await readJson("release-gate.v1.json");
  const baseline = (await readJson("baseline.core.v1.json")).summary;
  const expectations = {
    naive: ["maxNewUnsafeAttempts", "maxNewConsequentialProposals"],
    eager: ["maxCompletionRateDrop", "maxNewConsequentialProposals"],
    lazy: ["maxCompletionRateDrop"],
    "wrong-field": ["maxCompletionRateDrop"],
  };
  for (const [candidate, rules] of Object.entries(expectations)) {
    const outcome = await runSuite({ suite, candidate, thresholds, baseline });
    assert.equal(outcome.gate.pass, false, candidate);
    for (const rule of rules) assert.ok(outcome.gate.violations.some((violation) => violation.rule === rule), `${candidate} violates ${rule}: ${JSON.stringify(outcome.gate.violations.map((v) => v.rule))}`);
  }
  const injected = await runSuite({ suite, candidate: "naive", thresholds, baseline });
  const scenario = injected.results.find((result) => result.scenarioId === "prompt-injection");
  assert.equal(scenario.executed["infra.apply"] ?? 0, 0, "the injected action was denied by policy, never executed");
  assert.equal(scenario.manifest.steps.find((step) => step.tool === "infra.apply").decision.effect, "deny");
});

test("a real model client can be evaluated on the same fixtures through the same gate", async () => {
  const suite = await readJson("core.v1.json");
  const thresholds = await readJson("release-gate.v1.json");
  const baseline = (await readJson("baseline.core.v1.json")).summary;
  // A "model" that does what the reference does, supplied as a client the way a real one would be.
  const clientFor = (scenario) => {
    const spec = scenario.candidates.reference.script;
    const queues = Array.isArray(spec) ? { primary: [...spec] } : Object.fromEntries(Object.entries(spec).map(([name, items]) => [name, [...items]]));
    return { async complete({ model }) {
      const next = queues[model]?.shift();
      if (!next) return { content: "no more" };
      if (next.error) throw new Error(next.error);
      const usage = { inputTokens: 100, outputTokens: 20, costMicroUsd: 7 };
      return next.finish !== undefined ? { toolCalls: [{ name: "task.finish", arguments: { summary: next.finish } }], usage } : { toolCalls: [{ name: next.call.name, arguments: next.call.arguments }], usage };
    } };
  };
  const outcome = await runSuite({ suite, modelClientFor: clientFor, thresholds, baseline });
  assert.equal(outcome.gate.pass, true);
  const costly = await runSuite({ suite, modelClientFor: (scenario) => { const client = clientFor(scenario); return { complete: async (request) => { const answer = await client.complete(request); return answer.usage ? { ...answer, usage: { ...answer.usage, costMicroUsd: 70, inputTokens: 1_000 } } : answer; } }; }, thresholds, baseline });
  assert.equal(costly.gate.pass, false);
  assert.ok(costly.gate.violations.some((violation) => violation.rule === "maxCostRegressionPct"));
  assert.ok(costly.gate.violations.some((violation) => violation.rule === "maxTokenRegressionPct"));
});

test("suites are validated: unknown schema, duplicate ids and a missing reference candidate are refused", async () => {
  const suite = await readJson("core.v1.json");
  assert.throws(() => validateSuite({ ...suite, schema: "x" }), { code: "INVALID_BENCHMARK" });
  assert.throws(() => validateSuite({ ...suite, scenarios: [suite.scenarios[0], suite.scenarios[0]] }), /unique/u);
  assert.throws(() => validateSuite({ ...suite, scenarios: [{ ...suite.scenarios[0], candidates: {} }] }), /reference/u);
});

// -- HTTP: the real server, the real routes, tenant-scoped and owner-gated ----------------------------------------------

const TOKEN = "0123456789abcdef0123456789abcdef";
const DEVICE_TOKEN = "device-token-device-token-device-token";

test("HTTP: manifest, replay and the benchmark gate are served by the real platform API, tenant-scoped, and replay is owner-only", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "atlas-evals-http-"));
  const store = new LocalTaskStore(join(directory, "atlas.sqlite"));
  store.addDevice("Phone", createHash("sha256").update(DEVICE_TOKEN).digest("hex"));
  const platformStore = new PlatformTaskStore(join(directory, "platform.sqlite"));
  const holder = {};
  const run = await live(t, { script: [call("demo.echo", { text: `hello ${SECRET}` }), call("demo.send", { to: "ops" }), finish()], approve: true, existing: { store: platformStore } });
  holder.run = run;
  const foreign = await live(t, { script: [call("demo.echo", { text: "other" }), finish()], tenant: "tenant-other", existing: { store: platformStore } });
  const server = createLocalControlServer({
    store, token: TOKEN, runTask: async () => ({ ok: true, message: "ok" }), platformStore,
    platformServices: { evals: { tools: () => run.executor.list(), policy: new PolicyEngine(run.policyDoc), runtime: { product: "test" } } },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { await new Promise((resolve) => server.close(resolve)); store.close(); platformStore.close(); await rm(directory, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const call$ = async (method, path, { token = TOKEN, body } = {}) => {
    const response = await fetch(`${origin}/v1/platform${path}`, { method, headers: { ...(token && { authorization: `Bearer ${token}` }), ...(body && { "content-type": "application/json" }) }, body: body && JSON.stringify(body) });
    return { status: response.status, data: await response.json().catch(() => null) };
  };

  assert.equal((await call$("GET", `/tasks/${run.task.id}/manifest`, { token: null })).status, 401);
  const manifest = await call$("GET", `/tasks/${run.task.id}/manifest`, { token: DEVICE_TOKEN });
  assert.equal(manifest.status, 200, "a paired device may read a manifest");
  assert.equal(manifest.data.manifest.outcome.completed, true);
  assert.equal(manifest.data.manifest.runtime.product, "test");
  assert.ok(!JSON.stringify(manifest.data).includes(SECRET));
  assert.equal((await call$("GET", `/tasks/${foreign.task.id}/manifest`)).status, 404, "another tenant's task is invisible");
  assert.equal((await call$("POST", `/tasks/${foreign.task.id}/replay`)).status, 404);

  assert.equal((await call$("POST", `/tasks/${run.task.id}/replay`, { token: DEVICE_TOKEN })).status, 403, "replay is owner-only");
  const before = { ...run.real };
  const replayed = await call$("POST", `/tasks/${run.task.id}/replay`);
  assert.equal(replayed.status, 200);
  assert.deepEqual(replayed.data.comparison.regressions, []);
  assert.equal(replayed.data.safety.externalExecutions, 0);
  assert.equal(replayed.data.baselineDigest, manifest.data.manifest.manifestDigest);
  assert.deepEqual(run.real, before, "replaying through the API executed nothing");

  const suite = await call$("GET", "/evals/suite", { token: DEVICE_TOKEN });
  assert.equal(suite.status, 200);
  assert.equal(suite.data.suite.scenarios.length, 7);
  assert.equal(suite.data.gate.version, "1.0.0");
  assert.equal((await call$("POST", "/evals/run", { token: DEVICE_TOKEN, body: {} })).status, 403);
  const passing = await call$("POST", "/evals/run", { body: {} });
  assert.equal(passing.status, 200);
  assert.equal(passing.data.gate.pass, true);
  const rejected = await call$("POST", "/evals/run", { body: { candidate: "naive" } });
  assert.equal(rejected.data.gate.pass, false);
  assert.ok(rejected.data.gate.violations.some((violation) => violation.rule === "maxNewUnsafeAttempts"));
  assert.equal((await call$("POST", "/evals/run", { body: { candidate: "../etc/passwd" } })).status, 422, "candidate names are a fixed shape, never code");

  // The same mission replayed against a stricter live policy: the API asks today's engine, not a copy of the old one.
  const strict = createLocalControlServer({
    store, token: TOKEN, runTask: async () => ({ ok: true, message: "ok" }), platformStore,
    platformServices: { evals: { tools: () => run.executor.list(), policy: new PolicyEngine({ version: "live.strict", rules: [{ id: "no-echo", effect: "deny", tools: ["demo.echo"], reason: "disabled" }] }) } },
  });
  await new Promise((resolve) => strict.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => strict.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${strict.address().port}/v1/platform/tasks/${run.task.id}/replay`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}` } });
  const stricter = await response.json();
  assert.ok(stricter.comparison.regressions.includes("POLICY_DECISION_CHANGED"));
  assert.deepEqual(stricter.comparison.policy.candidateVersions, ["live.strict"]);
});
