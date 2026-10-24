import test from "node:test";
import assert from "node:assert/strict";
import { isInventoryObjective } from "./inspect-objective.mjs";

test("generic inventory objectives are supported", () => {
  for (const objective of ["inspect", "Inspect the repository", "overview", "summarize codebase", "inventory the project"]) {
    assert.equal(isInventoryObjective(objective), true, objective);
  }
});

test("objective-specific requests cannot be falsely marked complete by inventory", () => {
  for (const objective of ["List all TODO comments in the Atlas codebase to identify unfinished work.", "begin improving upon yourself", "find a bug and fix it", "inspect and debug, focus on todos", ""]) {
    assert.equal(isInventoryObjective(objective), false, objective);
  }
});
