import assert from "node:assert/strict";
import test from "node:test";
import { normalizeRepositoryRelativePath } from "../src/domain/repository-location.js";

test("normalizes repository-relative paths", () => {
  assert.equal(normalizeRepositoryRelativePath("src\\domain\\model.ts"), "src/domain/model.ts");
  assert.throws(() => normalizeRepositoryRelativePath("../secret"));
  assert.throws(() => normalizeRepositoryRelativePath("C:\\secret"));
});
