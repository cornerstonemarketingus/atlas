import assert from "node:assert/strict";
import test from "node:test";
import { parseOllamaModels, recommendModel, retryDelay } from "../src/runtime.mjs";

test("parses Ollama's tabular list", () => {
  const output = "NAME ID SIZE MODIFIED\nqwen2.5-coder:7b abc 4.7 GB now\nllama3.2:3b def 2 GB yesterday\n";
  assert.deepEqual(parseOllamaModels(output), ["qwen2.5-coder:7b", "llama3.2:3b"]);
});

test("selects an installed model appropriate for available memory", () => {
  assert.equal(recommendModel(32 * 1024 ** 3, ["qwen2.5-coder:7b", "qwen2.5-coder:14b"]).selected, "qwen2.5-coder:14b");
  assert.equal(recommendModel(16 * 1024 ** 3, ["qwen2.5-coder:3b", "qwen2.5-coder:7b"]).selected, "qwen2.5-coder:7b");
  assert.equal(recommendModel(8 * 1024 ** 3, ["qwen2.5-coder:7b"]).selected, null);
});

test("retry delay backs off and is capped", () => {
  assert.equal(retryDelay(0), 2_000);
  assert.equal(retryDelay(3), 16_000);
  assert.equal(retryDelay(20), 60_000);
});
