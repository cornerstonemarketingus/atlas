import assert from "node:assert/strict";
import test from "node:test";
import { renderSourceJson, renderSourceText } from "../src/presentation/source-renderers.js";

const result = {
  schemaVersion: 1 as const,
  root: "C:\\repo",
  path: "src/example.ts",
  content: "first\nsecond",
  startLine: 4,
  endLine: 5,
  bytesRead: 12,
  truncated: false,
  truncatedByBytes: false,
  truncatedByLines: false,
};

test("renders source reads with stable line numbers", () => {
  const rendered = renderSourceText(result);
  assert.match(rendered, /4: first/u);
  assert.match(rendered, /5: second/u);
});

test("renders the versioned source result as JSON", () => {
  assert.deepEqual(JSON.parse(renderSourceJson(result)), result);
});
