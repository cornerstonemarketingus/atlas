import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { ExecutionDeadline } from "../src/infrastructure/execution-deadline.js";

test("one deadline aborts all phases and can be disposed before expiry", async () => {
  const deadline = new ExecutionDeadline(25);
  await delay(50);
  assert.equal(deadline.expired, true);
  assert.equal(deadline.signal.reason.message, "EXECUTION_DEADLINE_EXCEEDED");
  const disposed = new ExecutionDeadline(25);
  disposed.dispose();
  await delay(50);
  assert.equal(disposed.expired, false);
  assert.throws(() => new ExecutionDeadline(0), RangeError);
  assert.throws(() => new ExecutionDeadline(Infinity), RangeError);
});
