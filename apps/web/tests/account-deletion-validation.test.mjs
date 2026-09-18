import assert from "node:assert/strict";
import test from "node:test";
import { validateDeletionDecision } from "../app/api/account/deletion/operator/validation.mjs";

test("requires an exact request id before destructive processing", () => {
  const result = validateDeletionDecision({ action: "complete", confirmation: "wrong" }, "request-123");
  assert.equal(result.status, 400);
});

test("accepts completion with a bounded optional audit note", () => {
  const result = validateDeletionDecision({ action: "complete", confirmation: "request-123", note: "Verified ownership." }, "request-123");
  assert.deepEqual(result, { decision: { action: "complete", note: "Verified ownership." } });
});

test("requires a reason for rejection", () => {
  const result = validateDeletionDecision({ action: "reject", confirmation: "request-123", note: "" }, "request-123");
  assert.equal(result.status, 400);
});

test("rejects unknown actions and oversized notes", () => {
  assert.equal(validateDeletionDecision({ action: "erase", confirmation: "request-123" }, "request-123").status, 400);
  assert.equal(validateDeletionDecision({ action: "complete", confirmation: "request-123", note: "x".repeat(501) }, "request-123").status, 400);
});
