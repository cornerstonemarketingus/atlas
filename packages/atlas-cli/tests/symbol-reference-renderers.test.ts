import assert from "node:assert/strict";
import test from "node:test";
import { renderSymbolReferenceJson, renderSymbolReferenceText } from "../src/presentation/symbol-reference-renderers.js";

const result = {
  schemaVersion: 1 as const,
  root: "C:\\repo",
  query: "Atlas",
  filesScanned: 1,
  bytesScanned: 20,
  occurrences: [{
    name: "Atlas",
    classification: "declaration" as const,
    path: "src/atlas.ts",
    line: 2,
    column: 14,
    language: "typescript" as const,
  }],
  warnings: [],
};

test("renders reference locations and classifications", () => {
  assert.match(renderSymbolReferenceText(result), /src\/atlas\.ts:2:14: declaration Atlas/u);
});

test("renders reference results as versioned JSON", () => {
  assert.deepEqual(JSON.parse(renderSymbolReferenceJson(result)), result);
});
