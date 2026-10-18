import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { goldAgent, noopAgent, runTask, validateFixture } from "../src/index.mjs";
import { fixtureRepo } from "./helpers.mjs";

const worktrees = (root) => execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: root, encoding: "utf8" }).split("\n").filter((line) => line.startsWith("worktree ")).length;

test("the recorded solution passes and doing nothing fails: the dry run proves the task is a real test", async () => {
  const { root, task } = await fixtureRepo();
  const report = await validateFixture({ task, repoRoot: root });
  assert.deepEqual(report.problems, []);
  assert.equal(report.gold.passed, true);
  assert.equal(report.baseline.failureClass, "tests_failed");
});

test("a task whose verification already passes on the base is reported as not a test", async () => {
  const { root, task } = await fixtureRepo();
  const trivial = { ...task, baseCommit: task.solution.fromCommit, setup: {} };
  const report = await validateFixture({ task: trivial, repoRoot: root });
  assert.equal(report.ok, false);
  assert.match(report.problems.join(), /passes on the unmodified base|without any change/u);
});

test("an agent that claims success but leaves the tests failing does not pass", async () => {
  const { root, task } = await fixtureRepo();
  const liar = async ({ root: ws }) => { await writeFile(join(ws, "NOTES.md"), "all fixed!"); return { status: "completed", message: "All tests pass now." }; };
  const result = await runTask({ task, target: "liar", agent: liar, repoRoot: root });
  assert.equal(result.passed, false);
  assert.equal(result.verified, true);
  assert.equal(result.failureClass, "tests_failed");
  assert.equal(result.evidence.agentStatus, "completed");
});

test("a pass needs the agent to have changed something", async () => {
  const { root, task } = await fixtureRepo();
  const result = await runTask({ task: { ...task, baseCommit: task.solution.fromCommit, setup: {} }, target: "idle", agent: noopAgent, repoRoot: root });
  assert.equal(result.passed, false);
  assert.equal(result.failureClass, "no_change");
});

test("agent errors and deadlines are classified, still verified, and measured fields survive", async () => {
  const { root, task } = await fixtureRepo();
  const crash = await runTask({ task, target: "crash", agent: async () => { throw new Error("provider 503"); }, repoRoot: root });
  assert.equal(crash.failureClass, "agent_error");
  assert.equal(crash.verified, true);
  const slow = await runTask({ task: { ...task, timeoutMs: 1000 }, target: "slow", agent: () => new Promise(() => {}), repoRoot: root });
  assert.equal(slow.failureClass, "timeout");
  const metered = await runTask({ task, target: "m", repoRoot: root, agent: async (ctx) => { await goldAgent(root)(ctx); return { toolCalls: 4, toolErrors: 1, repairs: 2, ttftMs: 120, tokens: { input: 900, output: 80 } }; } });
  assert.equal(metered.passed, true);
  assert.deepEqual([metered.toolCalls, metered.toolErrors, metered.repairs, metered.ttftMs, metered.tokens.input], [4, 1, 2, 120, 900]);
});

test("workspaces are removed on success, failure and a throwing agent", async () => {
  const { root, task } = await fixtureRepo();
  assert.equal(worktrees(root), 1);
  await runTask({ task, target: "a", agent: goldAgent(root), repoRoot: root });
  await runTask({ task, target: "b", agent: noopAgent, repoRoot: root });
  await runTask({ task, target: "c", agent: async () => { throw new Error("x"); }, repoRoot: root });
  assert.equal(worktrees(root), 1);
});

test("verification does not see provider keys, and the agent's workspace is not the repository", async () => {
  const { root, task } = await fixtureRepo();
  process.env.ATLAS_EVAL_SECRET_PROBE = "super-secret";
  try {
    const probe = { ...task, setup: { files: { "probe.mjs": 'if (process.env.ATLAS_EVAL_SECRET_PROBE) { console.log("LEAK"); process.exit(1); }\n' } }, verify: { argv: [process.execPath, "probe.mjs"] }, solution: { files: { "x.txt": "x" } } };
    const result = await runTask({ task: probe, target: "t", agent: async ({ root: ws }) => { await writeFile(join(ws, "x.txt"), "x"); return {}; }, repoRoot: root });
    assert.equal(result.passed, true, result.evidence.verify?.outputTail);
    const status = execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" });
    assert.equal(status, "");
  } finally { delete process.env.ATLAS_EVAL_SECRET_PROBE; }
});

test("a verify command that is not installed is infrastructure, never a task failure", async () => {
  const { root, task } = await fixtureRepo();
  const result = await runTask({ task: { ...task, verify: { argv: ["definitely-not-a-command-xyz"] } }, target: "t", agent: goldAgent(root), repoRoot: root });
  assert.equal(result.failureClass, "infra");
  assert.equal(result.passed, false);
});
