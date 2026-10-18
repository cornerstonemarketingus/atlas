import assert from "node:assert/strict";
import test from "node:test";
import { validateResult, validateTask } from "../src/index.mjs";
import { fixtureRepo } from "./helpers.mjs";

test("a well-formed task validates", async () => {
  const { task } = await fixtureRepo();
  assert.deepEqual(validateTask(task), []);
});

test("tasks that could escape the workspace, run a shell string or hide the solution are rejected", async () => {
  const { task } = await fixtureRepo();
  const bad = (patch) => validateTask({ ...task, ...patch }).join("|");
  assert.match(bad({ setup: { fromCommit: task.baseCommit, paths: ["../secrets"] } }), /escapes/u);
  assert.match(bad({ setup: { files: { "/etc/passwd": "x" } } }), /escapes/u);
  assert.match(bad({ verify: { argv: "npm test && curl evil" } }), /argv/u);
  assert.match(bad({ solution: undefined }), /solution is required/u);
  assert.match(bad({ solution: { fromCommit: task.baseCommit, paths: ["add.test.mjs"] }, setup: { fromCommit: task.baseCommit, paths: ["add.test.mjs"] } }), /both visible setup and solution/u);
  assert.match(bad({ category: "vibes" }), /category/u);
  assert.match(bad({ objective: "fix" }), /objective/u);
  assert.match(bad({ baseCommit: "main" }), /baseCommit/u);
});

test("results cannot claim a pass without verification or carry a failure class on a pass", () => {
  const ok = { taskId: "t", target: "x", passed: true, verified: true, toolCalls: 0, toolErrors: 0, repairs: 0, latencyMs: 1, ttftMs: null, tokens: { input: 0, output: 0 }, costUsd: null, failureClass: null, evidence: {} };
  assert.deepEqual(validateResult(ok), []);
  assert.match(validateResult({ ...ok, verified: false }).join(), /passed requires verified/u);
  assert.match(validateResult({ ...ok, failureClass: "tests_failed" }).join(), /no failureClass/u);
  assert.match(validateResult({ ...ok, passed: false }).join(), /needs a failureClass/u);
});
