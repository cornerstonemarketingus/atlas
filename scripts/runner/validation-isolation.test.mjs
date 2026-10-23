import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { coderValidationArguments } from "./validation-isolation.mjs";

test("hosted coder refuses missing or relative isolation configuration", () => {
  assert.throws(() => coderValidationArguments({ GITHUB_ACTIONS: "true" }), /host validation is refused/);
  assert.throws(() => coderValidationArguments({ GITHUB_ACTIONS: "true", ATLAS_VERIFY_CONTAINER: "docker" }), /absolute/);
});

test("container runtime is an argv value, while local execution remains compatible", () => {
  assert.deepEqual(coderValidationArguments({}), []);
  assert.deepEqual(coderValidationArguments({ GITHUB_ACTIONS: "true", ATLAS_VERIFY_CONTAINER: process.execPath }), ["--verify-container", process.execPath]);
});

test("hosted coder workflow supplies required isolation and never directly installs target dependencies", async () => {
  const workflow = await readFile(new URL("../../.github/workflows/atlas-coder.yml", import.meta.url), "utf8");
  assert.match(workflow, /ATLAS_VERIFY_CONTAINER: \/usr\/bin\/docker/);
  assert.doesNotMatch(workflow, /working-directory: target\//);
  const runner = await readFile(new URL("./run-task.mjs", import.meta.url), "utf8");
  assert.match(runner, /coderValidationArguments\(\)/);
});
