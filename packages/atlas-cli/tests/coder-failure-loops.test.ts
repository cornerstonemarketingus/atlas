import assert from "node:assert/strict";
import test from "node:test";

import { ProviderReadOnlyToolAgent } from "../src/agent/provider-read-only-tool-agent.js";
import { ToolFailureTracker } from "../src/agent/tool-failure-tracker.js";
import { VerifiedCoderSession } from "../src/agent/verified-coder-session.js";
import type { VerificationPlan } from "../src/agent/verification-planning.js";
import type { ValidationComparison, ValidationSnapshot } from "../src/domain/validation-result.js";
import { InMemorySessionAuditLog } from "../src/infrastructure/in-memory-session-audit-log.js";
import { PolicyEnforcedReadOnlyToolRegistry } from "../src/infrastructure/policy-enforced-read-only-tool-registry.js";
import type { ModelProvider, ModelRequest, ModelResponse, ModelToolDefinition } from "../src/model/model-provider.js";

const metadata = { id: "mock", displayName: "Mock", models: [{ model: "test", contextWindowTokens: 10_000, maxOutputTokens: 1_000, supportsTools: true, supportsJson: true, supportsStreaming: false }] };
const tools: ModelToolDefinition[] = [
  { name: "repository.edit", description: "Edit.", inputSchema: { type: "object", additionalProperties: true } },
  { name: "repository.inspect", description: "Inspect.", inputSchema: { type: "object", additionalProperties: true } },
];

function reply(id: string, content: ModelResponse["message"]["content"], finishReason: ModelResponse["finishReason"]): ModelResponse {
  return { id, providerId: "mock", model: "test", message: { role: "assistant", content }, finishReason, usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 } };
}
const call = (id: string, name: string, args: Record<string, unknown> = {}) => reply(id, [{ type: "tool-call", id, name, arguments: args as never }], "tool-calls");

/** `edit` always fails the way a stale edit does; `inspect` always works. */
function agentFor(script: (turn: number, request: ModelRequest) => ModelResponse, options: { maximumTurns?: number; failureLimits?: { identicalFailures?: number; consecutiveFailures?: number } } = {}) {
  const requests: ModelRequest[] = [];
  const registry = new PolicyEnforcedReadOnlyToolRegistry({ policy: { defaultDecision: "allow", rules: [] } });
  registry.register({ name: "repository.edit", description: "Edit.", risk: "low", validateInput: (input) => input, execute: async () => { throw Object.assign(new Error("Replacement text does not match the file."), { code: "EDIT_MISMATCH" }); } });
  registry.register({ name: "repository.inspect", description: "Inspect.", risk: "low", validateInput: (input) => input, execute: async () => ({ ok: true }) });
  const provider: ModelProvider = { metadata, async complete(request) { requests.push(structuredClone(request)); return script(requests.length, request); } };
  const audit = new InMemorySessionAuditLog();
  const agent = new ProviderReadOnlyToolAgent({ provider, model: "test", registry, tools, audit, maximumTurns: options.maximumTurns ?? 8, ...(options.failureLimits ? { toolFailureLimits: options.failureLimits } : {}) });
  const run = () => agent.run({ sessionId: "s", objective: "Fix it", evidence: [], scope: { kind: "global" }, context: { repositoryId: "atlas" } });
  return { run, requests, audit };
}

test("tracker: a second identical failure is corrected, a third stops, a success only resets the streak", () => {
  const t = new ToolFailureTracker();
  const same = { tool: "repository.edit", argumentsDigest: "d1", errorCode: "EDIT_MISMATCH" };
  assert.equal(t.recordFailure(same).action, "continue");
  assert.equal(t.recordFailure(same).action, "correct");
  t.recordSuccess();
  assert.equal(t.recordFailure(same).action, "stop", "identical failures are counted across successes");
  const n = new ToolFailureTracker();
  for (let i = 0; i < 4; i++) assert.notEqual(n.recordFailure({ ...same, argumentsDigest: `d${i}` }).action, "stop");
  const fifth = n.recordFailure({ ...same, argumentsDigest: "d9" });
  assert.equal(fifth.action, "stop");
  assert.equal(fifth.action === "stop" ? fifth.reason : "", "no-progress");
  assert.throws(() => new ToolFailureTracker({ identicalFailures: 1 }), RangeError);
});

test("the same failing edit sent three times ends the run as blocked after three requests, with guidance on the second", async () => {
  const f = agentFor((turn) => call(`c${turn}`, "repository.edit", { path: "a.ts", content: "x" }), { maximumTurns: 30 });
  const result = await f.run();
  assert.equal(result.status, "blocked");
  assert.match(result.status === "blocked" ? result.message : "", /Repeated tool failure: repository\.edit failed 3 times/u);
  assert.equal(f.requests.length, 3, "no turns are spent after the third identical failure");
  const toolMessages = result.trace.messages.filter((m) => m.role === "tool").map((m) => JSON.stringify(m.content));
  assert.match(toolMessages[1]!, /guidance/u);
  assert.match(toolMessages[1]!, /failed 2 times/u);
  assert.ok(f.audit.snapshot().some((e) => e.type === "error.recorded" && JSON.stringify(e.payload).includes("REPEATED_TOOL_FAILURE")));
});

test("different failing calls in a row stop as no-progress, but a success in between keeps the run going", async () => {
  const broken = agentFor((turn) => call(`c${turn}`, "repository.edit", { path: `f${turn}.ts` }), { maximumTurns: 30 });
  const stopped = await broken.run();
  assert.equal(stopped.status, "blocked");
  assert.match(stopped.status === "blocked" ? stopped.message : "", /No progress: 5 tool calls in a row failed/u);
  assert.equal(broken.requests.length, 5);

  // fail, fail, success, fail, fail, success ... never 5 in a row
  const mixed = agentFor((turn) => turn >= 13 ? reply("done", [{ type: "text", text: "Finished." }], "stop")
    : call(`c${turn}`, turn % 3 === 0 ? "repository.inspect" : "repository.edit", { n: turn }), { maximumTurns: 30 });
  assert.equal((await mixed.run()).status, "completed");
});

test("at the turn limit the last turn is a tool-free status report; nothing is hidden and no limit is raised", async () => {
  const f = agentFor((turn, request) => request.tools === undefined
    ? reply("report", [{ type: "text", text: "Inspected only; changed no files." }], "stop")
    : call(`c${turn}`, "repository.inspect", { turn }), { maximumTurns: 6 });
  const result = await f.run();
  assert.equal(result.status, "blocked");
  assert.equal(f.requests.length, 6, "exactly the configured turns, not more");
  assert.equal(f.requests.at(-1)!.tools, undefined, "the reserved turn offers no tools");
  assert.ok(f.requests.slice(0, -1).every((r) => r.tools !== undefined));
  const message = result.status === "blocked" ? result.message : "";
  assert.match(message, /^Turn limit reached\./u);
  assert.match(message, /unverified status report: Inspected only; changed no files\./u);
  assert.ok(JSON.stringify(f.requests[3]!.messages).includes("Turn budget: 3 turns remain"), "the model is warned while it can still finish");
  assert.equal(result.trace.turns, 6);
});

test("a failed status report still ends as a plain blocked result", async () => {
  let failFinal = false;
  const f = agentFor((turn, request) => { if (request.tools === undefined) { failFinal = true; throw new Error("provider down"); } return call(`c${turn}`, "repository.inspect", { turn }); }, { maximumTurns: 5 });
  const result = await f.run();
  assert.ok(failFinal);
  assert.equal(result.status, "blocked");
  assert.equal(result.status === "blocked" ? result.message : "", "Turn limit reached.");
});

test("a very small turn budget keeps every turn for work", async () => {
  const f = agentFor((turn) => call(`c${turn}`, "repository.inspect", { turn }), { maximumTurns: 3 });
  const result = await f.run();
  assert.equal(result.status, "blocked");
  assert.equal(f.requests.length, 3);
  assert.ok(f.requests.every((r) => r.tools !== undefined));
});

// ---- partial work is reported, not discarded -----------------------------------------------
const plan: VerificationPlan = { profiles: [{ id: "test:test", kind: "test", executable: "npm", args: ["run", "test"] }], skipped: false, skipReason: null };
const snap = (label: ValidationSnapshot["label"]): ValidationSnapshot => ({ label, observations: [{ caseId: "test:test", kind: "test", attempt: 1, outcome: "passed", command: { executable: "npm", argumentCount: 2, workingDirectory: ".", exitCode: 0, elapsedMilliseconds: 1 }, diagnostics: [] }] });
const cmp = (exitRecommendation: ValidationComparison["exitRecommendation"], newCount: number): ValidationComparison => ({
  diagnostics: Array.from({ length: newCount }, (_u, i) => ({ fingerprint: `v${i}`, classification: "new" as const, caseId: "test:test", kind: "test" as const, diagnostic: { severity: "error" as const, message: `new ${i}` } })),
  summary: { fixed: 0, new: newCount, persistent: 0, flakyOrInconclusive: 0, baselineInfrastructureFailures: 0, postChangeInfrastructureFailures: 0 }, exitRecommendation,
});

for (const [name, recommendation, newCount, expected] of [["clean", "accept", 0, "unverified"], ["breaking", "reject", 2, "regressed"], ["flaky", "rerun", 0, "inconclusive"]] as const) {
  test(`edits made before a turn-limit stop are kept and checked against the baseline (${name})`, async () => {
    const labels: string[] = [];
    const session = new VerifiedCoderSession({
      plan,
      runAgent: async () => ({ status: "blocked", response: "", message: "Turn limit reached.", edits: [{ path: "a.ts", operation: "update" }] }),
      runValidation: async (label) => { labels.push(label); return snap(label); },
      compare: () => cmp(recommendation, newCount),
    });
    const result = await session.run();
    assert.equal(result.status, "blocked", "the stop is never upgraded to completed");
    assert.deepEqual(result.edits, [{ path: "a.ts", operation: "update" }]);
    assert.deepEqual(labels, ["baseline", "post-change"]);
    assert.equal(result.verification.status, expected);
    assert.notEqual(result.verification.status, "verified");
    assert.match(result.verification.message, /^Partial work: The agent stopped with status 'blocked' after changing 1 file\(s\), so the objective is not confirmed\./u);
  });
}

test("a stop with no edits, or a cancelled run, does not run validation", async () => {
  for (const [status, edits] of [["blocked", []], ["cancelled", [{ path: "a.ts", operation: "update" as const }]]] as const) {
    const labels: string[] = [];
    const session = new VerifiedCoderSession({ plan, runAgent: async () => ({ status, response: "", message: "x", edits }), runValidation: async (label) => { labels.push(label); return snap(label); }, compare: () => cmp("accept", 0) });
    const result = await session.run();
    assert.deepEqual(labels, ["baseline"]);
    assert.equal(result.verification.status, "not-applicable");
  }
});

test("every route's request is bounded by its real context window, with room kept for the reply", async () => {
  const { contextRequestByteLimit } = await import("../src/cli.js");
  assert.equal(contextRequestByteLimit(8_192, 512), (8_192 - 512) * 3);
  assert.equal(contextRequestByteLimit(2_000_000, 8_192), 4_000_000, "capped at the agent's own maximum");
  assert.equal(contextRequestByteLimit(2_048, 2_000), 8_192, "never smaller than a usable floor");
});
