import assert from "node:assert/strict";
import test from "node:test";
import {
  VerifiedCoderSession,
  type AgentEvidence,
  type AgentPassResult,
  type ProposedEdit,
} from "../src/agent/verified-coder-session.js";
import type { VerificationPlan } from "../src/agent/verification-planning.js";
import type {
  ValidationComparison,
  ValidationObservation,
  ValidationSnapshot,
} from "../src/domain/validation-result.js";

const plan: VerificationPlan = {
  profiles: [{ id: "test:test", kind: "test", executable: "npm", args: ["run", "test"] }],
  skipped: false,
  skipReason: null,
};

const skippedPlan: VerificationPlan = {
  profiles: [],
  skipped: true,
  skipReason: "No runnable build, test, typecheck, or lint script was found in package.json, so this change could not be verified.",
};

function pass(edits: readonly ProposedEdit[], status: AgentPassResult["status"] = "completed"): AgentPassResult {
  return { status, response: "did the thing", message: null, edits };
}

function snapshot(label: ValidationSnapshot["label"], outcome: ValidationObservation["outcome"] = "passed"): ValidationSnapshot {
  return {
    label,
    observations: [{
      caseId: "test:test",
      kind: "test",
      attempt: 1,
      outcome,
      command: { executable: "npm", argumentCount: 2, workingDirectory: ".", exitCode: outcome === "passed" ? 0 : 1, elapsedMilliseconds: 5 },
      diagnostics: outcome === "passed" ? [] : [{ severity: "error", code: "command-exit-nonzero", message: "boom" }],
    }],
  };
}

function comparison(
  exitRecommendation: ValidationComparison["exitRecommendation"],
  newCount = 0,
): ValidationComparison {
  return {
    diagnostics: Array.from({ length: newCount }, (_unused, index) => ({
      fingerprint: `vd-${index}`,
      classification: "new" as const,
      caseId: "test:test",
      kind: "test" as const,
      diagnostic: { severity: "error" as const, message: `new failure ${index}` },
    })),
    summary: {
      fixed: 0,
      new: newCount,
      persistent: 0,
      flakyOrInconclusive: 0,
      baselineInfrastructureFailures: 0,
      postChangeInfrastructureFailures: 0,
    },
    exitRecommendation,
  };
}

test("verifies a clean change in a single pass", async () => {
  const validationLabels: string[] = [];
  const session = new VerifiedCoderSession({
    plan,
    runAgent: async () => pass([{ path: "a.ts", operation: "update" }]),
    runValidation: async (label) => { validationLabels.push(label); return snapshot(label); },
    compare: () => comparison("accept"),
  });

  const result = await session.run();

  assert.equal(result.verification.status, "verified");
  assert.equal(result.verification.attempts, 1);
  assert.deepEqual(validationLabels, ["baseline", "post-change"]);
  assert.deepEqual(result.edits, [{ path: "a.ts", operation: "update" }]);
  assert.match(result.verification.message, /Verified/u);
});

test("repairs a self-inflicted failure and reports the pass count", async () => {
  const seenEvidence: (readonly AgentEvidence[])[] = [];
  let agentCalls = 0;
  const session = new VerifiedCoderSession({
    plan,
    baseEvidence: [{ label: "Repository summary", content: "{}" }],
    runAgent: async (evidence) => { seenEvidence.push(evidence); agentCalls += 1; return pass([{ path: "a.ts", operation: "update" }]); },
    runValidation: async (label) => snapshot(label),
    compare: () => (agentCalls === 1 ? comparison("reject", 1) : comparison("accept")),
  });

  const result = await session.run();

  assert.equal(result.verification.status, "verified");
  assert.equal(result.verification.attempts, 2);
  assert.equal(agentCalls, 2);
  // The first pass sees only base evidence; the repair pass additionally sees what it broke.
  assert.equal(seenEvidence[0]?.length, 1);
  assert.equal(seenEvidence[1]?.length, 2);
  assert.match(seenEvidence[1]?.[1]?.content ?? "", /new failure 0/u);
});

test("gives up as a regression once the repair budget is exhausted", async () => {
  let agentCalls = 0;
  const session = new VerifiedCoderSession({
    plan,
    maxRepairAttempts: 1,
    runAgent: async () => { agentCalls += 1; return pass([{ path: "a.ts", operation: "update" }]); },
    runValidation: async (label) => snapshot(label),
    compare: () => comparison("reject", 2),
  });

  const result = await session.run();

  assert.equal(result.verification.status, "regressed");
  assert.equal(agentCalls, 2, "one initial pass plus one repair");
  assert.equal(result.verification.summary?.new, 2);
  assert.equal(result.verification.newFailures.length, 2);
  assert.match(result.verification.message, /introduced 2 validation failure/u);
});

test("never repairs when the repair budget is zero", async () => {
  let agentCalls = 0;
  const session = new VerifiedCoderSession({
    plan,
    maxRepairAttempts: 0,
    runAgent: async () => { agentCalls += 1; return pass([{ path: "a.ts", operation: "update" }]); },
    runValidation: async (label) => snapshot(label),
    compare: () => comparison("reject", 1),
  });

  const result = await session.run();
  assert.equal(result.verification.status, "regressed");
  assert.equal(agentCalls, 1);
});

test("reports an infrastructure or flaky comparison as inconclusive, not a regression", async () => {
  const session = new VerifiedCoderSession({
    plan,
    runAgent: async () => pass([{ path: "a.ts", operation: "update" }]),
    runValidation: async (label) => snapshot(label),
    compare: () => comparison("rerun"),
  });

  const result = await session.run();
  assert.equal(result.verification.status, "inconclusive");
  assert.match(result.verification.message, /needs a human look/u);
});

test("skips validation entirely when no runnable checks were planned", async () => {
  let validationCalls = 0;
  const session = new VerifiedCoderSession({
    plan: skippedPlan,
    runAgent: async () => pass([{ path: "a.ts", operation: "update" }]),
    runValidation: async (label) => { validationCalls += 1; return snapshot(label); },
  });

  const result = await session.run();

  assert.equal(result.verification.status, "unverified");
  assert.equal(validationCalls, 0);
  assert.match(result.verification.message, /could not be verified/u);
});

test("degrades to unverified when the baseline checks cannot even start", async () => {
  const labels: string[] = [];
  const session = new VerifiedCoderSession({
    plan,
    runAgent: async () => pass([{ path: "a.ts", operation: "update" }]),
    runValidation: async (label) => { labels.push(label); return snapshot(label, "execution-failed"); },
  });

  const result = await session.run();

  assert.equal(result.verification.status, "unverified");
  assert.match(result.verification.message, /dependencies are likely not installed/u);
  assert.deepEqual(labels, ["baseline"], "post-change validation is pointless without a usable baseline");
});

test("does not verify when the agent proposed no changes", async () => {
  let validationCalls = 0;
  const session = new VerifiedCoderSession({
    plan,
    runAgent: async () => pass([]),
    runValidation: async (label) => { validationCalls += 1; return snapshot(label); },
  });

  const result = await session.run();

  assert.equal(result.verification.status, "not-applicable");
  assert.match(result.verification.message, /nothing to verify/u);
  assert.equal(validationCalls, 1, "only the baseline ran, before we knew there would be no edits");
});

test("does not verify when the agent itself failed", async () => {
  const session = new VerifiedCoderSession({
    plan,
    runAgent: async () => ({ status: "failed", response: "", message: "provider exploded", edits: [] }),
    runValidation: async (label) => snapshot(label),
  });

  const result = await session.run();

  assert.equal(result.status, "failed");
  assert.equal(result.verification.status, "not-applicable");
  assert.match(result.verification.message, /stopped with status 'failed'/u);
});

test("accumulates edits across passes, keeping a creation a creation", async () => {
  let agentCalls = 0;
  const session = new VerifiedCoderSession({
    plan,
    runAgent: async () => {
      agentCalls += 1;
      return agentCalls === 1
        ? pass([{ path: "new.ts", operation: "create" }, { path: "b.ts", operation: "update" }])
        : pass([{ path: "new.ts", operation: "update" }, { path: "c.ts", operation: "update" }]);
    },
    runValidation: async (label) => snapshot(label),
    compare: () => (agentCalls === 1 ? comparison("reject", 1) : comparison("accept")),
  });

  const result = await session.run();

  assert.deepEqual(result.edits, [
    { path: "b.ts", operation: "update" },
    { path: "c.ts", operation: "update" },
    { path: "new.ts", operation: "create" },
  ]);
});

test("integrates with the real comparator: a genuinely new failure drives a repair", async () => {
  // No injected compare() here — this exercises compareValidationSnapshots for real.
  let agentCalls = 0;
  const session = new VerifiedCoderSession({
    plan,
    runAgent: async () => { agentCalls += 1; return pass([{ path: "a.ts", operation: "update" }]); },
    runValidation: async (label) => {
      if (label === "baseline") return snapshot("baseline", "passed");
      return agentCalls === 1 ? snapshot("post-change", "failed") : snapshot("post-change", "passed");
    },
  });

  const result = await session.run();

  assert.equal(result.verification.status, "verified");
  assert.equal(result.verification.attempts, 2, "the real comparator classified the failure as new and triggered one repair");
});

test("integrates with the real comparator: a pre-existing failure does not block the change", async () => {
  const session = new VerifiedCoderSession({
    plan,
    runAgent: async () => pass([{ path: "a.ts", operation: "update" }]),
    // Failing identically before and after: persistent, not introduced.
    runValidation: async (label) => snapshot(label, "failed"),
  });

  const result = await session.run();

  assert.equal(result.verification.status, "verified");
  assert.equal(result.verification.attempts, 1);
  assert.equal(result.verification.summary?.persistent, 1);
  assert.equal(result.verification.summary?.new, 0);
});

test("rejects an out-of-range repair budget", () => {
  const options = {
    plan,
    runAgent: async () => pass([]),
    runValidation: async (label: ValidationSnapshot["label"]) => snapshot(label),
  };
  assert.throws(() => new VerifiedCoderSession({ ...options, maxRepairAttempts: -1 }), RangeError);
  assert.throws(() => new VerifiedCoderSession({ ...options, maxRepairAttempts: 11 }), RangeError);
});

test("escalates to the stronger model once the repair budget is spent, continuing from the same checkpoint", async () => {
  const calls: { runner: string; evidence: readonly AgentEvidence[] }[] = [];
  const comparisons = [comparison("reject", 2), comparison("reject", 2), comparison("reject", 1), comparison("accept")];
  const session = new VerifiedCoderSession({
    plan,
    maxRepairAttempts: 1,
    runAgent: async (evidence) => { calls.push({ runner: "primary", evidence }); return pass([{ path: "a.ts", operation: "update" }]); },
    escalation: {
      attempts: 2,
      runAgent: async (evidence) => { calls.push({ runner: "escalation", evidence }); return pass([{ path: "b.ts", operation: "create" }]); },
    },
    runValidation: async (label) => snapshot(label),
    compare: () => comparisons.shift()!,
  });
  const result = await session.run();
  assert.equal(result.verification.status, "verified");
  assert.deepEqual(calls.map((call) => call.runner), ["primary", "primary", "escalation", "escalation"]);
  assert.equal(result.verification.escalatedAtPass, 3);
  assert.match(result.verification.message, /repaired by the escalation model from pass 3/u);
  // No restart: the escalation model gets the failures the change introduced, and every edit is kept.
  assert.match(calls[2]!.evidence.at(-1)!.content, /new failure/u);
  assert.deepEqual(result.edits.map((edit) => edit.path), ["a.ts", "b.ts"]);
});

test("escalation has its own bounded budget and reports the regression honestly", async () => {
  let escalationPasses = 0;
  const session = new VerifiedCoderSession({
    plan,
    maxRepairAttempts: 1,
    runAgent: async () => pass([{ path: "a.ts", operation: "update" }]),
    escalation: { attempts: 2, runAgent: async () => { escalationPasses += 1; return pass([{ path: "a.ts", operation: "update" }]); } },
    runValidation: async (label) => snapshot(label),
    compare: () => comparison("reject", 1),
  });
  const result = await session.run();
  assert.equal(result.verification.status, "regressed");
  assert.equal(escalationPasses, 2);
  assert.equal(result.verification.attempts, 4);
  assert.match(result.verification.message, /including 2 by the escalation model/u);
});

test("without an escalation route the behaviour is unchanged", async () => {
  const session = new VerifiedCoderSession({
    plan,
    maxRepairAttempts: 1,
    runAgent: async () => pass([{ path: "a.ts", operation: "update" }]),
    runValidation: async (label) => snapshot(label),
    compare: () => comparison("reject", 1),
  });
  const result = await session.run();
  assert.equal(result.verification.status, "regressed");
  assert.equal(result.verification.attempts, 2);
  assert.equal(result.verification.escalatedAtPass, undefined);
});

test("rejects an out-of-range escalation budget", () => {
  assert.throws(() => new VerifiedCoderSession({ plan, runAgent: async () => pass([]), runValidation: async (label) => snapshot(label), escalation: { attempts: 0, runAgent: async () => pass([]) } }), RangeError);
});
