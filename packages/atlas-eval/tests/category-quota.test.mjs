import assert from "node:assert/strict";
import test from "node:test";
import { summarize, toJson, toMarkdown } from "../src/index.mjs";

const observation = (taskId, failureClass = null, target = "free") => ({
  taskId, target, passed: failureClass === null, verified: true, failureClass,
  toolCalls: 0, toolErrors: 0, repairs: 0, latencyMs: 10, ttftMs: null,
  tokens: { input: 0, output: 0 }, costUsd: null, evidence: {},
});
const task = id => ({ id, category: "test-repair" });

test("one pass and one quota refusal use the same target and category denominator", () => {
  const report = { results: [observation("pass"), observation("refused", "quota")], tasks: [task("pass"), task("refused")], generatedAt: "now" };
  const summary = JSON.parse(toJson(report)).summary.free;
  assert.equal(summary.passRate, 1);
  assert.deepEqual(summary.categories["test-repair"], { runs: 2, passed: 1, attempted: 1, quotaRefusals: 1, passRate: 1 });
  assert.match(toMarkdown(report), /\| free \| test-repair \| 1\/1 \(100%\), 1 refused for quota \|/u);
});

test("genuine failures remain in category pass rates while quota refusals stay visible", () => {
  const results = [observation("pass"), observation("refused", "quota"), observation("failed", "tests_failed")];
  const tasks = results.map(result => task(result.taskId));
  const summary = summarize(results, tasks).free;
  assert.equal(summary.passRate, 0.5);
  assert.deepEqual(summary.categories["test-repair"], { runs: 3, passed: 1, attempted: 2, quotaRefusals: 1, passRate: 0.5 });
  assert.match(toMarkdown({ results, tasks, generatedAt: "now" }), /\| free \| test-repair \| 1\/2 \(50%\), 1 refused for quota \|/u);
});

test("all-quota categories have no pass rate and do not affect other targets or categories", () => {
  const results = [observation("refused", "quota"), observation("other-category"), observation("other-target", null, "eligible")];
  const tasks = [task("refused"), { id: "other-category", category: "navigation" }, task("other-target")];
  const summary = summarize(results, tasks);
  assert.deepEqual(summary.free.categories["test-repair"], { runs: 1, passed: 0, attempted: 0, quotaRefusals: 1, passRate: null });
  assert.equal(summary.free.categories.navigation.passRate, 1);
  assert.equal(summary.eligible.categories["test-repair"].passRate, 1);
  assert.match(toMarkdown({ results, tasks, generatedAt: "now" }), /\| free \| test-repair \| 0\/0 \(n\/a\), 1 refused for quota \|/u);
});
