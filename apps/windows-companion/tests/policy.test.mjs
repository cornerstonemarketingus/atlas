import assert from "node:assert/strict";
import test from "node:test";
import { actionRisk, validateAction } from "../src/policy.mjs";

test("allows reversible navigation and ordinary form preparation", () => {
  assert.equal(actionRisk({ type: "navigate", url: "https://example.com" }).decision, "allow");
  assert.equal(actionRisk({ type: "fill", label: "First name", value: "Ada" }).decision, "allow");
});

test("asks before consequential or sensitive actions", () => {
  assert.equal(actionRisk({ type: "click", name: "Submit application" }).decision, "ask");
  assert.equal(actionRisk({ type: "click", name: "Send message" }).decision, "ask");
  assert.equal(actionRisk({ type: "fill", label: "Social Security number", value: "..." }).decision, "ask");
});

test("denies unknown actions and rejects oversized fields", () => {
  assert.equal(actionRisk({ type: "run_script" }).decision, "deny");
  assert.throws(() => validateAction({ type: "fill", value: "x".repeat(4001) }), /Invalid action field/u);
});
