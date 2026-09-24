import test from "node:test";
import assert from "node:assert/strict";
import { correlationFooter, correlationIdFromEnv, correlationLogSuffix, isCorrelationId, withCorrelationId } from "./correlation.mjs";

const id = `cor_${"a1".repeat(16)}`;

test("accepts only cor_ + 32 lowercase hex from the environment", () => {
  assert.equal(correlationIdFromEnv({ ATLAS_CORRELATION_ID: id }), id);
  assert.equal(correlationIdFromEnv({ CORRELATION_ID: id }), id);
  for (const bad of ["", "cor_123", id.toUpperCase(), `${id}\nforged log line`, `tsk_${"a".repeat(32)}`, `cor_${"g".repeat(32)}`]) {
    assert.equal(correlationIdFromEnv({ ATLAS_CORRELATION_ID: bad }), null, bad);
  }
  assert.equal(correlationIdFromEnv({}), null);
  assert.equal(isCorrelationId(undefined), false);
});

test("footer, log suffix and payload include the id only when valid", () => {
  assert.deepEqual(correlationFooter(id), ["", `Atlas-Correlation-Id: ${id}`]);
  assert.deepEqual(correlationFooter(null), []);
  assert.deepEqual(correlationFooter("cor_bad"), []);
  assert.equal(correlationLogSuffix(id), ` [correlation ${id}]`);
  assert.equal(correlationLogSuffix(null), "");
  assert.deepEqual(withCorrelationId({ taskId: "t", summary: "s" }, id), { taskId: "t", summary: "s", correlationId: id });
  assert.deepEqual(withCorrelationId({ taskId: "t", summary: "s" }, "nope"), { taskId: "t", summary: "s" });
});
