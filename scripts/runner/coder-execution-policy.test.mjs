import assert from "node:assert/strict";
import test from "node:test";
import { coderExecutionPolicy } from "./coder-execution-policy.mjs";

test("coder deadline reserves a bounded checkpoint and cancellation window", () => {
  assert.deepEqual(coderExecutionPolicy({}), { timeoutMs: 900000, executionTimeoutMs: 870000, checkpointIntervalMs: 15000 });
  assert.deepEqual(coderExecutionPolicy({ ATLAS_CODER_TIMEOUT_MS: "5000", ATLAS_CODER_CHECKPOINT_INTERVAL_MS: "1000" }), { timeoutMs: 5000, executionTimeoutMs: 4000, checkpointIntervalMs: 1000 });
  assert.equal(coderExecutionPolicy({ ATLAS_CODER_TIMEOUT_MS: "2700000" }).executionTimeoutMs, 2670000);
});

test("invalid deadline settings cannot silently remove a bound", () => {
  for (const input of ["0", "-1", "Infinity", "NaN", "4.5", "2700001", "900000oops"]) {
    assert.throws(() => coderExecutionPolicy({ ATLAS_CODER_TIMEOUT_MS: input }), /ATLAS_CODER_TIMEOUT_MS/);
  }
  assert.throws(() => coderExecutionPolicy({ ATLAS_CODER_CHECKPOINT_INTERVAL_MS: "999" }), /CHECKPOINT_INTERVAL/);
});

test("coder budget cannot consume the workflow's recovery and PR window", () => {
  assert.equal(coderExecutionPolicy({ ATLAS_JOB_TIMEOUT_MINUTES: "25" }).timeoutMs, 900000);
  assert.throws(() => coderExecutionPolicy({ ATLAS_JOB_TIMEOUT_MINUTES: "25", ATLAS_CODER_TIMEOUT_MS: "900001" }), /leave at least 10 minutes/);
  assert.equal(coderExecutionPolicy({ ATLAS_JOB_TIMEOUT_MINUTES: "60", ATLAS_CODER_TIMEOUT_MS: "2700000" }).timeoutMs, 2700000);
  assert.throws(() => coderExecutionPolicy({ ATLAS_JOB_TIMEOUT_MINUTES: "Infinity" }), /ATLAS_JOB_TIMEOUT_MINUTES/);
});
