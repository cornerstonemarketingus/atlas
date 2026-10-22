#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { runSuite } from "../src/platform/evals/index.mjs";

/**
 * The release gate, from the command line.
 *
 *   node scripts/eval.mjs                       run the suite with the reference candidate and gate it
 *   node scripts/eval.mjs --candidate naive     run a named scripted candidate (scenarios that lack it use the reference)
 *   node scripts/eval.mjs --update-baseline     record the reference run as the new baseline (review the diff)
 *
 * Exit code 1 when the gate rejects the candidate. A model, router, prompt or
 * skill change is evaluated by calling `runSuite({ modelClientFor })` with the
 * real client; this script is the deterministic gate CI runs on every change.
 */
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "benchmarks");
const read = (name) => JSON.parse(readFileSync(join(root, name), "utf8"));
const flag = (name) => process.argv.includes(`--${name}`);
const candidate = process.argv.includes("--candidate") ? process.argv[process.argv.indexOf("--candidate") + 1] : "reference";

const suite = read("core.v1.json");
const thresholds = read("release-gate.v1.json");
if (flag("update-baseline")) {
  const { summary } = await runSuite({ suite });
  writeFileSync(join(root, "baseline.core.v1.json"), `${JSON.stringify({ suite: { id: suite.id, version: suite.version }, summary }, null, 1)}\n`);
  console.log(`Baseline for ${suite.id}@${suite.version} written. Review the diff before committing it.`);
  process.exit(0);
}
const baseline = read("baseline.core.v1.json").summary;
const outcome = await runSuite({ suite, candidate, thresholds, baseline });
for (const result of outcome.results) console.log(`${result.expectations.met ? "ok  " : "FAIL"} ${result.scenarioId.padEnd(28)} ${result.manifest.outcome.status.padEnd(20)} ${result.expectations.failures.join("; ")}`);
const { perScenario: _omit, ...numbers } = outcome.summary;
console.log(JSON.stringify(numbers));
console.log(outcome.gate.pass ? `GATE PASSED (thresholds ${outcome.gate.thresholdsVersion})` : `GATE REJECTED (thresholds ${outcome.gate.thresholdsVersion}):\n${outcome.gate.violations.map((v) => `  - ${v.rule}: observed ${v.observed}, limit ${v.limit} (${v.why})`).join("\n")}`);
process.exit(outcome.gate.pass ? 0 : 1);
