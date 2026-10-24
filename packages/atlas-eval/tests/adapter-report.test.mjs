import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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
  assert.deepEqual(summary.categories, {
    navigation: { runs: 1, passed: 1, attempted: 1, quotaRefusals: 0, passRate: 1 },
    feature: { runs: 1, passed: 0, attempted: 1, quotaRefusals: 0, passRate: 0 },
  });
  assert.match(toMarkdown({ results, tasks, generatedAt: "now" }), /\| t1 \| 1\/2 \(50%\)/u);
});

test("the checked-in tasks all load and have unique ids matching their files", async () => {
  const tasks = await loadTasks(fileURLToPath(new URL("../../../evals/tasks/", import.meta.url)));
  assert.ok(tasks.length >= 30);
  assert.ok(new Set(tasks.map((task) => task.category)).size >= 8);
});

test("Workers AI also receives its account id, and nothing else beyond the named key", async () => {
  const dir = await mkdtemp(join(tmpdir(), "eval-cli-wai-"));
  const fake = join(dir, "cli.mjs");
  await writeFile(fake, `console.log(JSON.stringify({ status: "completed", toolCalls: 0, inputTokens: 0, outputTokens: 0, summary: Object.keys(process.env).filter((k) => /CLOUDFLARE|TOKEN|SECRET/.test(k)).sort().join(",") }));`);
  const env = { PATH: process.env.PATH, HOME: dir, ATLAS_WORKERS_AI_TOKEN: "k", CLOUDFLARE_ACCOUNT_ID: "a".repeat(32), OTHER_SECRET: "nope", GITHUB_MODELS_TOKEN: "nope" };
  const outcome = await atlasCliAgent({ cliPath: fake, env })({ root: dir, objective: "x", target: "workers-ai:@cf/openai/gpt-oss-120b:ATLAS_WORKERS_AI_TOKEN", signal: new AbortController().signal });
  assert.equal(outcome.message, "ATLAS_WORKERS_AI_TOKEN,CLOUDFLARE_ACCOUNT_ID");
  const groq = await atlasCliAgent({ cliPath: fake, env })({ root: dir, objective: "x", target: "groq:openai/gpt-4.1-mini:GITHUB_MODELS_TOKEN:https://models.github.ai/inference", signal: new AbortController().signal });
  assert.equal(groq.message, "GITHUB_MODELS_TOKEN", "other providers get no account id");
});

test("a GitHub Models target parses with its https base URL", () => {
  assert.deepEqual(parseTarget("groq:openai/gpt-4.1-mini:GITHUB_MODELS_TOKEN:https://models.github.ai/inference"), { provider: "groq", model: "openai/gpt-4.1-mini", apiKeyEnv: "GITHUB_MODELS_TOKEN", baseUrl: "https://models.github.ai/inference" });
});
test("evaluation attempts do not inherit the production capacity queue and explicit experiments remain selectable", async t => {
  const dir = await mkdtemp(join(tmpdir(), "eval-attempt-policy-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const fake = join(dir, "cli.mjs");
  await writeFile(fake, `console.log(JSON.stringify({status:"failed",message:JSON.stringify(process.argv.slice(2)),toolCalls:0}));`);
  const env = { PATH: process.env.PATH, HOME: dir, GROQ_API_KEY: "fixture" };
  for (const extraArgs of [[], ["--capacity-wait-ms", "5000", "--retry-attempts", "2"]]) {
    const outcome = await atlasCliAgent({ cliPath: fake, env, extraArgs })({ root: dir, objective: "x", target: "groq:m:GROQ_API_KEY", signal: new AbortController().signal });
    const args = JSON.parse(outcome.message);
    assert.equal(args.filter(arg => arg === "--capacity-wait-ms").length, 1);
    assert.equal(args[args.indexOf("--capacity-wait-ms") + 1], extraArgs.length ? "5000" : "0");
    assert.equal(args[args.indexOf("--retry-attempts") + 1], extraArgs.length ? "2" : "1");
    assert.equal(outcome.status, "failed", "a refused attempt must not become a pass");
  }
});

test("partial progress survives in logs without copying arbitrary child stderr", async t => {
  const dir = await mkdtemp(join(tmpdir(), "eval-progress-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const fake = join(dir, "cli.mjs");
  await writeFile(fake, `process.stderr.write('PRIVATE_SENTINEL\\nAtlas progress: {"modelRequests":1,"toolCalls":0,"failedTools":0}\\n');console.log(JSON.stringify({status:"failed",message:"refused"}));`);
  const logged = [];
  t.mock.method(console, "log", value => logged.push(value));
  await atlasCliAgent({ cliPath: fake, env: { PATH: process.env.PATH, HOME: dir, GROQ_API_KEY: "fixture" } })({ root: dir, objective: "x", target: "groq:m:GROQ_API_KEY", signal: new AbortController().signal });
  assert.equal(logged.length, 1);
  assert.match(logged[0], /"modelRequests":1/u);
  assert.ok(!logged.join("").includes("PRIVATE_SENTINEL"));
});
