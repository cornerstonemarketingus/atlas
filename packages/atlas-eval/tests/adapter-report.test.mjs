import assert from "node:assert/strict";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { atlasCliAgent, loadTasks, measureAuditLog, parseTarget, summarize, toMarkdown } from "../src/index.mjs";

test("targets name the key variable, never the key", () => {
  assert.deepEqual(parseTarget("groq:llama-3.3:GROQ_API_KEY"), { provider: "groq", model: "llama-3.3", apiKeyEnv: "GROQ_API_KEY", baseUrl: undefined });
  assert.equal(parseTarget("openai:m:OPENAI_API_KEY:http://127.0.0.1:1/v1").baseUrl, "http://127.0.0.1:1/v1");
  for (const bad of ["groq:m:sk-live-abc", "nope:m:KEY", "groq::KEY", "groq"]) assert.throws(() => parseTarget(bad), /target must be/u, bad);
});

test("the audit trace yields tool failures and time to the first model response", () => {
  const lines = [
    { type: "session.started", occurredAt: "2026-10-18T10:00:00.000Z", payload: {} },
    { type: "model.responded", occurredAt: "2026-10-18T10:00:01.500Z", payload: {} },
    { type: "tool.completed", occurredAt: "2026-10-18T10:00:02.000Z", payload: { outcome: "failed" } },
    { type: "tool.completed", occurredAt: "2026-10-18T10:00:03.000Z", payload: { outcome: "succeeded" } },
    { type: "model.responded", occurredAt: "2026-10-18T10:00:04.000Z", payload: {} },
  ].map((event) => JSON.stringify(event)).join("\n") + "\nnot json\n";
  assert.deepEqual(measureAuditLog(lines), { toolErrors: 1, ttftMs: 1500 });
});

test("the CLI adapter passes only the named key to the coder and reads its receipt", async () => {
  const dir = await mkdtemp(join(tmpdir(), "eval-cli-"));
  const fake = join(dir, "cli.mjs");
  await writeFile(fake, `const leaked = Object.keys(process.env).filter((k) => /OTHER_SECRET|GROQ/.test(k)).sort();
console.log(JSON.stringify({ status: "completed", toolCalls: 3, inputTokens: 100, outputTokens: 20, verification: { attempts: 2 }, summary: leaked.join(",") }));`);
  await chmod(fake, 0o755);
  const agent = atlasCliAgent({ cliPath: fake, env: { PATH: process.env.PATH, HOME: dir, GROQ_API_KEY: "k", OTHER_SECRET: "nope" } });
  const outcome = await agent({ root: dir, objective: "do it", target: "groq:m:GROQ_API_KEY", signal: new AbortController().signal });
  assert.equal(outcome.message, "GROQ_API_KEY");
  assert.deepEqual([outcome.toolCalls, outcome.repairs, outcome.tokens.input, outcome.tokens.output], [3, 1, 100, 20]);
  await assert.rejects(atlasCliAgent({ cliPath: fake, env: { PATH: process.env.PATH } })({ root: dir, objective: "x", target: "groq:m:GROQ_API_KEY", signal: new AbortController().signal }), /GROQ_API_KEY is not set/u);
});

test("reports count verified passes per target and category", () => {
  const base = { verified: true, toolCalls: 4, toolErrors: 1, repairs: 0, latencyMs: 100, ttftMs: 10, tokens: { input: 5, output: 1 }, costUsd: null, evidence: {} };
  const results = [
    { ...base, taskId: "a", target: "t1", passed: true, failureClass: null },
    { ...base, taskId: "b", target: "t1", passed: false, failureClass: "tests_failed" },
  ];
  const tasks = [{ id: "a", category: "navigation" }, { id: "b", category: "feature" }];
  const summary = summarize(results, tasks).t1;
  assert.equal(summary.passRate, 0.5);
  assert.equal(summary.toolAccuracy, 0.75);
  assert.deepEqual(summary.categories, { navigation: { runs: 1, passed: 1 }, feature: { runs: 1, passed: 0 } });
  assert.match(toMarkdown({ results, tasks, generatedAt: "now" }), /\| t1 \| 1\/2 \(50%\)/u);
});

test("the checked-in tasks all load and have unique ids matching their files", async () => {
  const tasks = await loadTasks(new URL("../../../evals/tasks/", import.meta.url).pathname);
  assert.ok(tasks.length >= 10);
  assert.ok(new Set(tasks.map((task) => task.category)).size >= 4);
});
