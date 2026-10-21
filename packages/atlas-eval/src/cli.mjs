#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { appendEntry, atlasCliAgent, draftTask, loadTasks, readLog, recurringFailures, runTask, selectShard, toJson, toMarkdown, validateFixture } from "./index.mjs";

const USAGE = `atlas-eval validate [--tasks dir] [--only id]
atlas-eval dogfood add --task <text> --outcome success|failed|abandoned [--failure-class slug] --model <name> --input-tokens N --output-tokens N --intervention yes|no [--notes text]
atlas-eval dogfood check | drafts [--threshold N] [--write-drafts dir]
atlas-eval run --target provider:model:API_KEY_ENV[:base-url] [--target ...] [--tasks dir] [--only id] [--shard k/n|day/n] [--out report-prefix]`;
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");

function option(args, name) { const i = args.indexOf(name); return i === -1 ? undefined : args[i + 1]; }
function options(args, name) { return args.flatMap((arg, i) => (arg === name ? [args[i + 1]] : [])); }

async function dogfood(args) {
  const file = resolve(option(args, "--log") ?? join(repoRoot, "evals/dogfood/log.jsonl"));
  const [, action] = args;
  if (action === "add") {
    const outcome = option(args, "--outcome");
    const record = await appendEntry(file, {
      task: option(args, "--task"), outcome, failureClass: outcome === "success" ? null : option(args, "--failure-class") ?? null, model: option(args, "--model"),
      tokens: { input: Number(option(args, "--input-tokens")), output: Number(option(args, "--output-tokens")) },
      humanIntervention: option(args, "--intervention") === "yes", notes: option(args, "--notes"),
    });
    console.log(`recorded #${record.sequence}`);
    return 0;
  }
  const entries = await readLog(file);
  if (action === "check") { console.log(`${entries.length} entries, chain intact`); return 0; }
  if (action === "drafts") {
    const groups = recurringFailures(entries, Number(option(args, "--threshold") ?? 3));
    const out = option(args, "--write-drafts");
    for (const group of groups) {
      console.log(`${group.failureClass}: ${group.count} failures, ${group.interventions} needed a person (${group.models.join(", ")})`);
      if (out) { await mkdir(resolve(out), { recursive: true }); await writeFile(join(resolve(out), `${draftTask(group).id}.json`), JSON.stringify(draftTask(group), null, 2) + "\n"); }
    }
    if (groups.length === 0) console.log("no recurring failures");
    return 0;
  }
  console.error(USAGE);
  return 2;
}

async function main(args) {
  const [command] = args;
  if (command === "dogfood") return dogfood(args);
  const dir = resolve(option(args, "--tasks") ?? join(repoRoot, "evals/tasks"));
  const only = option(args, "--only");
  let tasks = (await loadTasks(dir)).filter((task) => only === undefined || task.id === only);
  const shard = option(args, "--shard");
  if (shard !== undefined) {
    const slice = selectShard(tasks, shard);
    console.log(`shard ${slice.index}/${slice.count}: ${slice.tasks.length} of ${tasks.length} tasks`);
    tasks = slice.tasks;
  }
  if (tasks.length === 0) { console.error("no tasks matched"); return 2; }
  if (command === "validate") {
    let failed = 0;
    for (const task of tasks) {
      const report = await validateFixture({ task, repoRoot });
      console.log(`${report.ok ? "ok  " : "FAIL"} ${task.id} (${task.category})${report.ok ? "" : "\n  " + report.problems.join("\n  ")}`);
      if (!report.ok) failed++;
    }
    console.log(`${tasks.length - failed}/${tasks.length} fixtures valid`);
    return failed === 0 ? 0 : 1;
  }
  if (command === "run") {
    const targets = options(args, "--target");
    if (targets.length === 0) { console.error(USAGE); return 2; }
    const agent = atlasCliAgent({ cliPath: join(repoRoot, "packages/atlas-cli/dist/src/cli.js") });
    const results = [];
    const notRun = [];
    for (const target of targets) for (const task of tasks) {
      // Once a provider refuses for quota, the rest of its tasks would only
      // record the same refusal; list them as not run and move on.
      if (results.some((r) => r.target === target && r.failureClass === "quota")) { notRun.push({ taskId: task.id, target, reason: "quota" }); continue; }
      const result = await runTask({ task, target, agent, repoRoot });
      console.log(`${result.passed ? "pass" : "fail"} ${task.id} ${target} ${result.failureClass ?? ""}`);
      // Why a run failed, so a CI log alone can tell a weak model from a broken setup.
      if (!result.passed) {
        const why = result.evidence.agentError ?? result.evidence.agentMessage ?? result.evidence.infraError ?? "";
        console.log(`  agent: ${result.evidence.agentStatus ?? "none"}; tool calls ${result.toolCalls}; tokens ${result.tokens.input}/${result.tokens.output}${why ? `; ${String(why).replace(/\s+/gu, " ").slice(0, 240)}` : ""}`);
      }
      results.push(result);
    }
    if (notRun.length > 0) console.log(`not run (quota): ${notRun.length}`);
    const report = { results, tasks, notRun, generatedAt: new Date().toISOString() };
    const out = option(args, "--out");
    if (out) { await writeFile(`${out}.json`, toJson(report)); await writeFile(`${out}.md`, toMarkdown(report)); }
    else console.log(toMarkdown(report));
    return 0;
  }
  console.error(USAGE);
  return 2;
}

process.exitCode = await main(process.argv.slice(2));
