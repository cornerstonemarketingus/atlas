import assert from "node:assert/strict";
import test from "node:test";

import { coderToolCallLimit, groqRequestByteLimit } from "../src/cli.js";

test("coder tool-call limit scales with turns within the agent's bounds", () => {
  assert.equal(coderToolCallLimit(1), 16);
  assert.equal(coderToolCallLimit(12), 36);
  assert.equal(coderToolCallLimit(32), 96);
  assert.equal(coderToolCallLimit(100), 128);
});

test("groq request cap stays at the free-tier size unless an output ceiling is set", () => {
  assert.equal(groqRequestByteLimit(undefined), 18_000);
  assert.equal(groqRequestByteLimit(8192), 160_000);
});
