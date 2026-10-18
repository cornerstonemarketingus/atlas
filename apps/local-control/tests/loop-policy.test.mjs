import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_LOOP_POLICY, decideIteration, failureFingerprint, loopPolicyFromEnvironment } from "../src/platform/loop-policy.mjs";
import { coderUsage } from "../src/platform/genesis/coder.mjs";

const failure = (output, extra = {}) => ({ stage: "verifying", check: "test", exitCode: 1, output, ...extra });

test("the same failure has the same fingerprint across runs; a different failure does not", () => {
  const a = failureFingerprint(failure("not ok 3 - adds\n  at /tmp/atlas-run-81/ws/src/add.mjs:12:7\n# duration_ms 41.2 commit 9f8e7d6c5b"));
  const b = failureFingerprint(failure("not ok 3 - adds\n  at C:\\Users\\x\\atlas-run-2\\ws\\src\\add.mjs:14:3\n# duration_ms 77.9 commit 0a1b2c3d4e"));
  assert.equal(a, b);
  assert.notEqual(a, failureFingerprint(failure("not ok 3 - subtracts\n  at src/add.mjs:12:7")));
  assert.notEqual(a, failureFingerprint(failure("not ok 3 - adds", { check: "build" })));
});

test("a loop stops when the same failure survives repairs, before paying for another", () => {
  const fp = "f1";
  const base = { startedAt: 0, now: 1000, fingerprint: fp };
  assert.equal(decideIteration({ ...base, iterations: [] }).proceed, true);
  assert.equal(decideIteration({ ...base, iterations: [{ fingerprint: fp, tokens: 10 }] }).proceed, true);
  const stopped = decideIteration({ ...base, iterations: [{ fingerprint: fp, tokens: 10 }, { fingerprint: fp, tokens: 10 }] });
  assert.equal(stopped.proceed, false);
  assert.equal(stopped.reason, "no-progress");
  assert.equal(stopped.sameFailure, 2);
  // A loop that keeps making progress (new failures each time) runs to its iteration limit instead.
  const progressing = decideIteration({ ...base, iterations: [{ fingerprint: "a", tokens: 1 }, { fingerprint: "b", tokens: 1 }, { fingerprint: "c", tokens: 1 }] });
  assert.equal(progressing.reason, "iteration-limit");
});

test("time and spend limits stop the loop before the next iteration, and unmetered work is counted", () => {
  const time = decideIteration({ policy: { maxWallMs: 60_000 }, iterations: [], startedAt: 0, now: 60_000, fingerprint: "x" });
  assert.equal(time.reason, "time-limit");
  const spend = decideIteration({ policy: { maxTokens: 1000 }, iterations: [{ fingerprint: "a", tokens: 600 }, { fingerprint: "b", tokens: 400 }], startedAt: 0, now: 1, fingerprint: "x" });
  assert.equal(spend.reason, "spend-limit");
  const unmetered = decideIteration({ policy: { maxTokens: 1000 }, iterations: [{ fingerprint: "a", tokens: null }], startedAt: 0, now: 1, fingerprint: "x" });
  assert.equal(unmetered.proceed, true);
  assert.equal(unmetered.unmeteredIterations, 1);
  assert.equal(DEFAULT_LOOP_POLICY.maxSameFailure, 2);
});

test("coder usage is summed from the run's audit trace, and an unreadable trace is unmetered", () => {
  const trace = [
    { type: "model.responded", payload: { inputTokens: 1200, outputTokens: 80 } },
    { type: "tool.completed", payload: {} },
    { type: "model.responded", payload: { inputTokens: 1500, outputTokens: 120 } },
  ].map((e) => JSON.stringify(e)).join("\n");
  assert.deepEqual(coderUsage("coder exited 0; audit /data/runs/2026.jsonl", (path) => { assert.equal(path, "/data/runs/2026.jsonl"); return trace; }), { inputTokens: 2700, outputTokens: 200, totalTokens: 2900 });
  assert.equal(coderUsage("coder exited 0; audit /missing.jsonl", () => { throw new Error("ENOENT"); }), null);
  assert.equal(coderUsage("no trace here"), null);
});

test("owner limits come from the environment, and a bad value is reported, not treated as unlimited", () => {
  assert.deepEqual(loopPolicyFromEnvironment({ ATLAS_REPAIR_MAX_MINUTES: "30", ATLAS_REPAIR_MAX_TOKENS: "200000" }), { maxWallMs: 1_800_000, maxTokens: 200_000 });
  const warnings = [];
  assert.deepEqual(loopPolicyFromEnvironment({ ATLAS_REPAIR_MAX_TOKENS: "unlimited", ATLAS_REPAIR_MAX_MINUTES: "-5" }, (w) => warnings.push(w)), {});
  assert.equal(warnings.length, 2);
});
