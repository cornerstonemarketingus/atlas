import assert from "node:assert/strict";
import test from "node:test";
import { goldAgent, isQuotaRefusal, runTask, selectShard, summarize, toMarkdown } from "../src/index.mjs";
import { fixtureRepo } from "./helpers.mjs";

test("a provider's 429 is a quota refusal, not a model failure, and stays out of the pass rate", async () => {
  const { root, task } = await fixtureRepo();
  const refused = await runTask({ task, target: "free", repoRoot: root, agent: async () => ({ status: "failed", message: "workers-ai returned HTTP 429" }) });
  assert.equal(refused.passed, false);
  assert.equal(refused.failureClass, "quota");
  const thrown = await runTask({ task, target: "free", repoRoot: root, agent: async () => { throw new Error("Groq endpoint returned HTTP 429"); } });
  assert.equal(thrown.failureClass, "quota");
  const passed = await runTask({ task, target: "free", repoRoot: root, agent: goldAgent(root) });
  const summary = summarize([passed, refused, thrown], [task]).free;
  assert.equal(summary.runs, 3);
  assert.equal(summary.attempted, 1);
  assert.equal(summary.passRate, 1);
  const markdown = toMarkdown({ results: [passed, refused], tasks: [task], notRun: [{ taskId: "later", target: "free", reason: "quota" }], generatedAt: "now" });
  assert.match(markdown, /1\/1 \(100%\), 1 refused for quota/u);
  assert.match(markdown, /## Not run[\s\S]*\| later \| free \|/u);
});

test("only a 429 is quota: other provider errors and a completed run that mentions one stay model failures", async () => {
  assert.equal(isQuotaRefusal("workers-ai returned HTTP 429"), true);
  assert.equal(isQuotaRefusal("workers-ai returned HTTP 500"), false);
  assert.equal(isQuotaRefusal("HTTP 4290"), false);
  const { root, task } = await fixtureRepo();
  const completed = await runTask({ task, target: "free", repoRoot: root, agent: async () => ({ status: "completed", message: "handled HTTP 429 retries" }) });
  assert.equal(completed.failureClass, "tests_failed");
});

test("shards deal every task exactly once, and day/n walks the slices on consecutive days", () => {
  const tasks = ["e", "a", "d", "c", "b"].map((id) => ({ id }));
  const slices = [1, 2, 3].map((k) => selectShard(tasks, `${k}/3`).tasks.map((t) => t.id));
  assert.deepEqual(slices, [["a", "d"], ["b", "e"], ["c"]]);
  const day = 86_400_000;
  const walked = [0, 1, 2].map((d) => selectShard(tasks, "day/3", (19_000 + d) * day).index).sort();
  assert.deepEqual(walked, [1, 2, 3]);
  for (const bad of ["0/3", "4/3", "x/3", "1/0", "3"]) assert.throws(() => selectShard(tasks, bad));
});
