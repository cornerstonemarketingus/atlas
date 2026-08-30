import assert from "node:assert/strict";
import test from "node:test";
import { validateRepositorySetting } from "../app/api/settings/repositories/validation.mjs";

test("accepts and normalizes a valid repository setting", () => {
  const result = validateRepositorySetting({ owner: "Cornerstonemarketingus", name: "atlas", mergePolicy: "ci-gated" });
  assert.deepEqual(result, { setting: { owner: "cornerstonemarketingus", name: "atlas", mergePolicy: "ci-gated" } });
});

test("accepts the zero-gate 'none' merge policy", () => {
  const result = validateRepositorySetting({ owner: "cornerstonemarketingus", name: "atlas", mergePolicy: "none" });
  assert.equal("error" in result, false);
  assert.equal(result.setting.mergePolicy, "none");
});

test("rejects an unrecognized merge policy", () => {
  const result = validateRepositorySetting({ owner: "cornerstonemarketingus", name: "atlas", mergePolicy: "auto" });
  assert.equal(result.status, 400);
});

test("rejects invalid owners, names, and missing payloads", () => {
  assert.equal(validateRepositorySetting(null).status, 400);
  assert.equal(validateRepositorySetting({ owner: "-bad-", name: "atlas", mergePolicy: "manual" }).status, 400);
  assert.equal(validateRepositorySetting({ owner: "cornerstonemarketingus", name: "../etc", mergePolicy: "manual" }).status, 400);
});
