#!/usr/bin/env node
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { GenesisService, GenesisStore } from "../../apps/local-control/src/platform/genesis/index.mjs";
import { GenesisExecutor } from "../../apps/local-control/src/platform/genesis/executor.mjs";
import { PreviewManager } from "../../apps/local-control/src/platform/genesis/preview.mjs";
import { createInspector } from "../../apps/local-control/src/platform/genesis/inspector.mjs";
import { createVisionReviewer } from "../../apps/local-control/src/platform/genesis/vision.mjs";
import { createGenesisCoder } from "../../apps/local-control/src/platform/genesis/coder.mjs";
import { ModelPlanStore } from "../../apps/local-control/src/agent/models/hosting.mjs";
import { runCheck } from "../../apps/local-control/src/platform/self-improve/runtime.mjs";

/**
 * Genesis benchmarks: the same product-building scenarios, run for real, with
 * the numbers that show whether Atlas is getting better at building software
 * (not just accumulating code).
 *
 *   node scripts/local/genesis-bench.mjs [--only crud,api] [--keep] [--no-model]
 *
 * For each scenario it records: completion (ready or not, and the final
 * stage), build and test success with test counts, browser verification
 * (full or HTTP-only), repair attempts, wall time, which models the coder
 * used, and whether a person had to intervene (a question or a block). The
 * run is written to ~/.atlas/genesis/benchmarks/<timestamp>.json.
 *
 * Nothing is published and nothing leaves the machine. The coder uses the
 * local model server (and the applied model plan) when one answers;
 * --no-model runs the template-only path.
 */

export const SCENARIOS = Object.freeze([
  { id: "marketing-site", prompt: "Build a website for my landscaping company" },
  { id: "crud", prompt: "Build a simple customer lead tracker with: add customer, name/email/phone, status, notes, dashboard, search" },
  { id: "dashboard", prompt: "Build a sales dashboard for my shop" },
  { id: "rest-api", prompt: "Build a REST API for managing inventory items" },
  { id: "auth-app", prompt: "Build a small app where my team can log in and track tasks" },
]);

const atlasRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

function option(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? null : process.argv[index + 1];
}

export async function runBenchmarks({ scenarios = SCENARIOS, useModel = true, keep = false, log = console.log } = {}) {
  const root = mkdtempSync(join(tmpdir(), "atlas-genesis-bench-"));
  const dataDirectory = join(homedir(), ".atlas");
  const store = new GenesisStore(join(root, "genesis.sqlite"));
  const genesis = new GenesisService({ store, policy: () => ({ decision: "allow" }) });
  const preview = new PreviewManager({ registryPath: join(root, "previews.json"), runPrepare: runCheck });
  const models = new Set();
  const baseCoder = useModel ? createGenesisCoder({ atlasRoot, dataDirectory, modelPlan: new ModelPlanStore(join(dataDirectory, "model-plan.json")), intelligence: genesis.intelligence }) : null;
  const coder = baseCoder ? Object.assign(async (input) => { const result = await baseCoder(input); if (result.model) models.add(result.model); return result; }, { available: baseCoder.available }) : null;
  const modelAvailable = coder ? await coder.available() : false;
  const executor = new GenesisExecutor({ genesis, projectsRoot: join(root, "projects"), runCheck, coder, preview, inspector: createInspector({ artifactsRoot: join(root, "inspections"), vision: useModel ? createVisionReviewer() : null }) });
  const results = [];
  try {
    for (const scenario of scenarios) {
      models.clear();
      const started = Date.now();
      log(`▶ ${scenario.id}: ${scenario.prompt}`);
      let view = await genesis.create(scenario.prompt);
      const interventions = [];
      if (view.state === "blocked" && view.spec.questions.length) {
        interventions.push({ kind: "questions", ids: view.spec.questions.map((q) => q.id) });
        view = await genesis.answer(view.id, Object.fromEntries(view.spec.questions.map((q) => [q.id, q.default ?? "no"])));
      }
      if (view.state === "approved") view = await executor.run(view.id);
      if (view.state === "blocked") interventions.push({ kind: "blocked", reason: view.transitions.at(-1).reason });
      const checks = view.transitions.findLast((t) => t.to === "previewing")?.evidence?.results ?? view.transitions.findLast((t) => t.evidence?.kind === "failure")?.evidence ?? null;
      const inspection = view.tasks.find((t) => t.executor === "browser")?.evidence?.at(-1) ?? null;
      const result = {
        id: scenario.id,
        prompt: scenario.prompt,
        template: view.plan?.template ?? null,
        state: view.state,
        completed: view.state === "ready",
        reason: view.transitions.at(-1)?.reason ?? null,
        build: Array.isArray(checks) ? checks.find((r) => r.name === "build")?.exitCode === 0 : false,
        tests: Array.isArray(checks) ? checks.find((r) => r.name === "test")?.summary ?? null : null,
        testsPassed: Array.isArray(checks) ? checks.find((r) => r.name === "test")?.exitCode === 0 : false,
        browser: inspection ? { mode: inspection.mode, ok: inspection.kind === "inspection" && !inspection.findings, checks: inspection.checks?.length ?? 0, visual: inspection.visual ?? null } : null,
        repairs: view.repairsUsed,
        durationMs: Date.now() - started,
        models: [...models],
        humanIntervention: interventions,
      };
      results.push(result);
      log(`  ${result.completed ? "✓ ready" : `✗ ${result.state}`} in ${(result.durationMs / 1000).toFixed(1)} s · tests ${result.tests ? `${result.tests.pass}/${result.tests.tests}` : "—"} · browser ${result.browser?.mode ?? "—"} · repairs ${result.repairs}${result.completed ? "" : ` · ${result.reason}`}`);
      await preview.stop(view.id);
    }
  } finally {
    await preview.stopAll();
    store.close();
    if (!keep) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
  const summary = {
    at: new Date().toISOString(),
    modelAvailable,
    completed: results.filter((r) => r.completed).length,
    total: results.length,
    browserVerified: results.filter((r) => r.browser?.mode === "browser").length,
    repairs: results.reduce((sum, r) => sum + r.repairs, 0),
    results,
    workspace: keep ? root : null,
  };
  return summary;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const only = option("--only")?.split(",") ?? null;
  const summary = await runBenchmarks({ scenarios: only ? SCENARIOS.filter((s) => only.includes(s.id)) : SCENARIOS, useModel: !process.argv.includes("--no-model"), keep: process.argv.includes("--keep") });
  const directory = join(homedir(), ".atlas", "genesis", "benchmarks");
  mkdirSync(directory, { recursive: true });
  const file = join(directory, `${summary.at.replaceAll(":", "-")}.json`);
  writeFileSync(file, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`\n${summary.completed}/${summary.total} ready · ${summary.browserVerified} browser-verified · ${summary.repairs} repairs · model ${summary.modelAvailable ? "available" : "not available"}\nSaved ${file}`);
  process.exitCode = summary.completed === summary.total ? 0 : 1;
}
