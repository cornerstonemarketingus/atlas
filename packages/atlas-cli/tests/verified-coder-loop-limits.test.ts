import assert from "node:assert/strict";
import test from "node:test";
import {
  VerifiedCoderSession,
  type AgentPassResult,
  type ProposedEdit,
} from "../src/agent/verified-coder-session.js";
import type { VerificationPlan } from "../src/agent/verification-planning.js";
import type { ValidationComparison, ValidationSnapshot } from "../src/domain/validation-result.js";
import { renderCodeJson, renderCodeText, toVerifiedCodeOutput } from "../src/presentation/code-renderers.js";

const plan: VerificationPlan = {
  profiles: [{ id: "test:test", kind: "test", executable: "npm", args: ["run", "test"] }],
  skipped: false,
  skipReason: null,
};
const skippedPlan: VerificationPlan = { profiles: [], skipped: true, skipReason: "Verification was disabled." };

function pass(edits: readonly ProposedEdit[] = [{ path: "a.ts", operation: "update" }]): AgentPassResult {
  return { status: "completed", response: "did the thing", message: null, edits };
}

function snapshot(label: ValidationSnapshot["label"]): ValidationSnapshot {
  return { label, observations: [] };
}

function accept(): ValidationComparison {
  return failingWith([], "accept");
}

function failingWith(messages: readonly string[] | string, exitRecommendation: ValidationComparison["exitRecommendation"] = "reject"): ValidationComparison {
  const list = typeof messages === "string" ? [messages] : messages;
  return {
    diagnostics: list.map((message, index) => ({
      fingerprint: `vd-${index}`,
      classification: "new" as const,
      caseId: "test:test",
      kind: "test" as const,
      diagnostic: { severity: "error" as const, message },
    })),
    summary: { fixed: 0, new: list.length, persistent: 0, flakyOrInconclusive: 0, baselineInfrastructureFailures: 0, postChangeInfrastructureFailures: 0 },
    exitRecommendation,
  };
}

test("no-progress: stops before the repair budget is spent when the same failure keeps surviving", async () => {
  let agentCalls = 0;
  const session = new VerifiedCoderSession({
    plan,
    maxRepairAttempts: 5,
    runAgent: async () => { agentCalls += 1; return pass(); },
    runValidation: async (label) => snapshot(label),
    // Run-specific noise (timings, line numbers) must not count as progress.
    compare: () => failingWith(`expected 1 to equal 2 at a.ts:${agentCalls}:4 (${agentCalls * 13}ms)`),
  });
  const result = await session.run();
  assert.equal(result.verification.status, "regressed");
  assert.equal(result.verification.stopReason, "no-progress");
  assert.equal(agentCalls, 3, "one initial pass plus two repairs of the same failure, not five");
  assert.equal(result.verification.attempts, 3);
  assert.equal(result.verification.loop?.repairs, 2);
  assert.equal(result.verification.loop?.sameFailure, 2);
  assert.equal(result.verification.loop?.limits.maxRepairAttempts, 5);
  assert.match(result.verification.message, /same failure survived 2 repair attempt\(s\).*\(no-progress\)/u);
});

test("no-progress: a changing failure is progress and keeps repairing up to the budget", async () => {
  let agentCalls = 0;
  const session = new VerifiedCoderSession({
    plan,
    maxRepairAttempts: 3,
    runAgent: async () => { agentCalls += 1; return pass(); },
    runValidation: async (label) => snapshot(label),
    compare: () => failingWith(["TypeError", "SyntaxError", "RangeError", "EvalError"][agentCalls - 1]!),
  });
  const result = await session.run();
  assert.equal(agentCalls, 4);
  assert.equal(result.verification.stopReason, "iteration-limit");
});

test("no-progress honours a custom same-failure limit", async () => {
  let agentCalls = 0;
  const session = new VerifiedCoderSession({
    plan,
    maxRepairAttempts: 5,
    loopLimits: { maxSameFailure: 1 },
    runAgent: async () => { agentCalls += 1; return pass(); },
    runValidation: async (label) => snapshot(label),
    compare: () => failingWith("boom"),
  });
  const result = await session.run();
  assert.equal(agentCalls, 2);
  assert.equal(result.verification.stopReason, "no-progress");
});

test("no-progress escalates once instead of stopping when an escalation model exists", async () => {
  const runners: string[] = [];
  const session = new VerifiedCoderSession({
    plan,
    maxRepairAttempts: 5,
    runAgent: async () => { runners.push("primary"); return pass(); },
    escalation: { attempts: 3, runAgent: async () => { runners.push("escalation"); return pass(); } },
    runValidation: async (label) => snapshot(label),
    compare: () => failingWith("boom"),
  });
  const result = await session.run();
  // Primary: initial + 2 repairs (no progress) -> escalation: 2 repairs (no progress again) -> stop, no second escalation.
  assert.deepEqual(runners, ["primary", "primary", "primary", "escalation", "escalation"]);
  assert.equal(result.verification.escalatedAtPass, 4);
  assert.equal(result.verification.stopReason, "no-progress");
  assert.equal(result.verification.loop?.repairs, 4);
  assert.match(result.verification.message, /including 2 by the escalation model/u);
});

test("an escalation that fixes the failure after no-progress is verified", async () => {
  const runners: string[] = [];
  const session = new VerifiedCoderSession({
    plan,
    maxRepairAttempts: 5,
    runAgent: async () => { runners.push("primary"); return pass(); },
    escalation: { attempts: 1, runAgent: async () => { runners.push("escalation"); return pass([{ path: "b.ts", operation: "create" }]); } },
    runValidation: async (label) => snapshot(label),
    compare: () => (runners.at(-1) === "escalation" ? accept() : failingWith("boom")),
  });
  const result = await session.run();
  assert.deepEqual(runners, ["primary", "primary", "primary", "escalation"]);
  assert.equal(result.verification.status, "verified");
  assert.equal(result.verification.stopReason, null);
  assert.equal(result.verification.loop?.repairs, 3);
});

test("time-limit: no repair starts once the wall-time limit has passed", async () => {
  let clock = 0;
  let agentCalls = 0;
  const session = new VerifiedCoderSession({
    plan,
    maxRepairAttempts: 5,
    loopLimits: { maxWallMs: 10_000 },
    now: () => clock,
    runAgent: async () => { agentCalls += 1; clock += 6_000; return pass(); },
    runValidation: async (label) => snapshot(label),
    compare: () => failingWith(`failure ${"xyz".repeat(agentCalls)}`),
  });
  const result = await session.run();
  assert.equal(agentCalls, 2, "the repair at 6s starts; the one at 12s does not");
  assert.equal(result.verification.stopReason, "time-limit");
  assert.equal(result.verification.loop?.elapsedMs, 12_000);
});

test("time-limit is not bypassed by escalation", async () => {
  let clock = 0;
  let escalationCalls = 0;
  const session = new VerifiedCoderSession({
    plan,
    maxRepairAttempts: 0,
    loopLimits: { maxWallMs: 5_000 },
    now: () => clock,
    runAgent: async () => { clock += 6_000; return pass(); },
    escalation: { attempts: 2, runAgent: async () => { escalationCalls += 1; return pass(); } },
    runValidation: async (label) => snapshot(label),
    compare: () => failingWith("boom"),
  });
  const result = await session.run();
  assert.equal(escalationCalls, 0);
  assert.equal(result.verification.stopReason, "time-limit");
});

test("spend-limit: no repair starts once the shared token budget is spent", async () => {
  let spent = 0;
  let agentCalls = 0;
  const session = new VerifiedCoderSession({
    plan,
    maxRepairAttempts: 5,
    loopLimits: { maxTokens: 1_000 },
    tokensSpent: () => spent,
    runAgent: async () => { agentCalls += 1; spent += 500; return pass(); },
    runValidation: async (label) => snapshot(label),
    compare: () => failingWith(`failure ${"xyz".repeat(agentCalls)}`),
  });
  const result = await session.run();
  assert.equal(agentCalls, 2);
  assert.equal(result.verification.stopReason, "spend-limit");
  assert.equal(result.verification.loop?.tokensSpent, 1_000);
  assert.equal(result.verification.loop?.limits.maxTokens, 1_000);
});

test("stopReason is iteration-limit when the attempt budget ends the loop, and null otherwise", async () => {
  const regressed = await new VerifiedCoderSession({
    plan, maxRepairAttempts: 1,
    runAgent: async () => pass(),
    runValidation: async (label) => snapshot(label),
    compare: () => failingWith("boom"),
  }).run();
  assert.equal(regressed.verification.stopReason, "iteration-limit");
  const verified = await new VerifiedCoderSession({
    plan,
    runAgent: async () => pass(),
    runValidation: async (label) => snapshot(label),
    compare: () => accept(),
  }).run();
  assert.equal(verified.verification.stopReason, null);
  assert.equal(verified.verification.loop, undefined, "no repair was considered");
  const skipped = await new VerifiedCoderSession({ plan: skippedPlan, runAgent: async () => pass(), runValidation: async (label) => snapshot(label) }).run();
  assert.equal(skipped.verification.stopReason, null);
});

test("rejects out-of-range loop limits", () => {
  const make = (loopLimits: object) => new VerifiedCoderSession({ plan, runAgent: async () => pass([]), runValidation: async (label) => snapshot(label), loopLimits });
  assert.throws(() => make({ maxSameFailure: 0 }), RangeError);
  assert.throws(() => make({ maxWallMs: 0 }), RangeError);
  assert.throws(() => make({ maxTokens: -1 }), RangeError);
  assert.doesNotThrow(() => make({ maxWallMs: null, maxTokens: null }));
});

test("the receipt carries stopReason and loop facts in JSON and text", async () => {
  const result = await new VerifiedCoderSession({
    plan,
    maxRepairAttempts: 5,
    tokensSpent: () => 321,
    loopLimits: { maxTokens: 4_000 },
    runAgent: async () => pass(),
    runValidation: async (label) => snapshot(label),
    compare: () => failingWith("boom"),
  }).run();
  const output = toVerifiedCodeOutput("session-1", result, { turns: 3, toolCalls: 2, inputTokens: 10, outputTokens: 321 });
  const json = JSON.parse(renderCodeJson(output));
  assert.equal(json.verification.stopReason, "no-progress");
  assert.equal(json.verification.loop.repairs, 2);
  assert.equal(json.verification.loop.tokensSpent, 321);
  assert.equal(json.verification.loop.limits.maxSameFailure, 2);
  assert.match(json.verification.loop.fingerprint, /^[0-9a-f]{16}$/u);
  const text = renderCodeText(output);
  assert.match(text, /Repair loop: stopped \(no-progress\); 2 repair\(s\), .*321\/4000 output tokens, same failure 2\/2/u);
});
