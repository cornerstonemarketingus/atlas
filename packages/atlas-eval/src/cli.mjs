#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { atlasCliAgent, loadTasks, runTask, toJson, toMarkdown, validateFixture } from "./index.mjs";

const USAGE = `atlas-eval validate [--tasks dir] [--only id]
atlas-eval run --target provider:model:API_KEY_ENV[:base-url] [--target ...] [--tasks dir] [--only id] [--out report-prefix]`;
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");

function option(args, name) { const i = args.indexOf(name); return i === -1 ? undefined : args[i + 1]; }
function options(args, name) { return args.flatMap((arg, i) => (arg === name ? [args[i + 1]] : [])); }

async function main(args) {
  const [command] = args;
  const dir = resolve(option(args, "--tasks") ?? join(repoRoot, "evals/tasks"));
  const only = option(args, "--only");
  const tasks = (await loadTasks(dir)).filter((task) => only === undefined || task.id === only);
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
    for (const target of targets) for (const task of tasks) {
      const result = await runTask({ task, target, agent, repoRoot });
      console.log(`${result.passed ? "pass" : "fail"} ${task.id} ${target} ${result.failureClass ?? ""}`);
      results.push(result);
    }
    const report = { results, tasks, generatedAt: new Date().toISOString() };
    const out = option(args, "--out");
    if (out) { await writeFile(`${out}.json`, toJson(report)); await writeFile(`${out}.md`, toMarkdown(report)); }
    else console.log(toMarkdown(report));
    return 0;
  }
  console.error(USAGE);
  return 2;
}

process.exitCode = await main(process.argv.slice(2));
