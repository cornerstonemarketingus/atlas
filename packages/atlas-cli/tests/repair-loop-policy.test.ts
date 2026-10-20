import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_REPAIR_LOOP_POLICY,
  decideRepair,
  failureFingerprint,
  type RepairLoopPolicy,
} from "../src/agent/repair-loop-policy.js";

const policy: RepairLoopPolicy = { maxRepairs: 5, maxWallMs: 60_000, maxTokens: 1_000, maxSameFailure: 2 };
const base = { policy, repairs: [], startedAt: 1_000, now: 1_000, tokensSpent: 0, fingerprint: "f1" };

test("defaults match the Genesis loop policy", () => {
  assert.equal(DEFAULT_REPAIR_LOOP_POLICY.maxWallMs, 6 * 60 * 60_000);
  assert.equal(DEFAULT_REPAIR_LOOP_POLICY.maxTokens, null);
  assert.equal(DEFAULT_REPAIR_LOOP_POLICY.maxSameFailure, 2);
});

test("proceeds when no limit is reached, and reports the facts", () => {
  const decision = decideRepair({ ...base, repairs: [{ fingerprint: "f0" }, { fingerprint: "f1" }], now: 4_000, tokensSpent: 120 });
  assert.equal(decision.proceed, true);
  assert.deepEqual(
    { repairs: decision.repairs, elapsedMs: decision.elapsedMs, tokensSpent: decision.tokensSpent, sameFailure: decision.sameFailure, fingerprint: decision.fingerprint },
    { repairs: 2, elapsedMs: 3_000, tokensSpent: 120, sameFailure: 1, fingerprint: "f1" },
  );
});

test("iteration-limit: stops once the repair budget is spent", () => {
  const at = decideRepair({ ...base, policy: { ...policy, maxRepairs: 2 }, repairs: [{ fingerprint: "a" }, { fingerprint: "b" }] });
  assert.equal(at.proceed, false);
  assert.equal(!at.proceed && at.reason, "iteration-limit");
  assert.equal(decideRepair({ ...base, policy: { ...policy, maxRepairs: 2 }, repairs: [{ fingerprint: "a" }] }).proceed, true);
  const zero = decideRepair({ ...base, policy: { ...policy, maxRepairs: 0 } });
  assert.equal(!zero.proceed && zero.reason, "iteration-limit");
});

test("time-limit: stops at the wall-time limit, not before; null means no limit", () => {
  const at = decideRepair({ ...base, now: base.startedAt + 60_000 });
  assert.equal(!at.proceed && at.reason, "time-limit");
  assert.equal(decideRepair({ ...base, now: base.startedAt + 59_999 }).proceed, true);
  assert.equal(decideRepair({ ...base, policy: { ...policy, maxWallMs: null }, now: base.startedAt + 10 ** 9 }).proceed, true);
  // A clock that went backwards is not negative elapsed time.
  assert.equal(decideRepair({ ...base, now: 0 }).elapsedMs, 0);
});

test("spend-limit: stops once the token budget is spent; unmetered spend never trips it", () => {
  const at = decideRepair({ ...base, tokensSpent: 1_000 });
  assert.equal(!at.proceed && at.reason, "spend-limit");
  assert.match(!at.proceed ? at.message : "", /1000 model output tokens/u);
  assert.equal(decideRepair({ ...base, tokensSpent: 999 }).proceed, true);
  assert.equal(decideRepair({ ...base, tokensSpent: null }).proceed, true);
  assert.equal(decideRepair({ ...base, policy: { ...policy, maxTokens: null }, tokensSpent: 10 ** 9 }).proceed, true);
});

test("no-progress: stops when the same failure survived the allowed number of repairs", () => {
  const at = decideRepair({ ...base, repairs: [{ fingerprint: "f1" }, { fingerprint: "f1" }] });
  assert.equal(!at.proceed && at.reason, "no-progress");
  assert.equal(at.sameFailure, 2);
  // Different failures each time are progress, however many there were.
  assert.equal(decideRepair({ ...base, repairs: [{ fingerprint: "a" }, { fingerprint: "b" }, { fingerprint: "c" }] }).proceed, true);
  assert.equal(decideRepair({ ...base, repairs: [{ fingerprint: "f1" }] }).proceed, true);
  const strict = decideRepair({ ...base, policy: { ...policy, maxSameFailure: 1 }, repairs: [{ fingerprint: "f1" }] });
  assert.equal(!strict.proceed && strict.reason, "no-progress");
});

test("rules are checked in a fixed order: attempts, time, spend, progress", () => {
  const all = { ...base, policy: { ...policy, maxRepairs: 2 }, repairs: [{ fingerprint: "f1" }, { fingerprint: "f1" }], now: 10 ** 9, tokensSpent: 10 ** 9 };
  const first = decideRepair(all);
  assert.equal(!first.proceed && first.reason, "iteration-limit");
  const second = decideRepair({ ...all, policy: { ...all.policy, maxRepairs: 5 } });
  assert.equal(!second.proceed && second.reason, "time-limit");
  const third = decideRepair({ ...all, policy: { ...all.policy, maxRepairs: 5, maxWallMs: null } });
  assert.equal(!third.proceed && third.reason, "spend-limit");
  const fourth = decideRepair({ ...all, policy: { ...all.policy, maxRepairs: 5, maxWallMs: null, maxTokens: null } });
  assert.equal(!fourth.proceed && fourth.reason, "no-progress");
});

test("fingerprint ignores run-specific noise but not the failure itself", () => {
  const first = failureFingerprint([
    "[test] test:test: Validation command exited with code 1.",
    "[test] test:test: \u001b[31mError\u001b[0m at /tmp/atlas-abc123/src/app.ts:12:5 after 41ms (commit 3f2a9c1d)",
  ]);
  const second = failureFingerprint([
    "[test]   test:test: error at /home/runner/work/x/src/app.ts:99:1 after 7.5ms (commit 0be4417a)",
    "[test] test:test: Validation command exited with code 2.",
  ]);
  assert.equal(first, second, "paths, numbers, hashes, colour, order, case and whitespace are noise");
  assert.match(first, /^[0-9a-f]{16}$/u);
  assert.notEqual(failureFingerprint(["[test] test:test: TypeError in app.ts"]), failureFingerprint(["[test] test:test: ReferenceError in app.ts"]));
  assert.notEqual(failureFingerprint(["[lint] lint:lint: bad"]), failureFingerprint(["[test] test:test: bad"]));
});
