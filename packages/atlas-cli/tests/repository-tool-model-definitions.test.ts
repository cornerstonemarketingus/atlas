import assert from "node:assert/strict";
import test from "node:test";
import { validateModelRequest } from "../src/model/model-contract-validation.js";
import { REPOSITORY_READ_ONLY_MODEL_TOOLS } from "../src/model/repository-tool-model-definitions.js";

test("repository model tool definitions are unique and contract-valid", () => {
  const names = REPOSITORY_READ_ONLY_MODEL_TOOLS.map((tool) => tool.name);
  assert.equal(new Set(names).size, names.length);
  assert.deepEqual(names, [
    "repository.inspect",
    "repository.search",
    "repository.symbols",
    "repository.references",
    "repository.read_source",
  ]);
  const request = validateModelRequest({
    model: "test",
    messages: [],
    tools: REPOSITORY_READ_ONLY_MODEL_TOOLS,
  });
  assert.equal(request.tools?.length, 5);
});
