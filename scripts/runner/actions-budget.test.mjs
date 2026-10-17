import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_ESTIMATED_RUN_MINUTES,
  DEFAULT_RESERVE_MINUTES,
  evaluateActionsBudget,
} from "./actions-budget.mjs";

test("allows a run with plenty of allowance left", () => {
  const verdict = evaluateActionsBudget({ includedMinutes: 2_000, usedMinutes: 100 });
  assert.equal(verdict.decision, "allow");
  assert.equal(verdict.remaining, 1_900);
});

test("blocks a run that would eat into the reserve kept for CI", () => {
  // 2000 included, 1650 used -> 350 left. A 120-minute run leaves 230,
  // under the 300 reserve, so ordinary CI would start failing to run.
  const verdict = evaluateActionsBudget({ includedMinutes: 2_000, usedMinutes: 1_650 });
  assert.equal(verdict.decision, "block");
  assert.match(verdict.reason, /300-minute reserve/u);
});

test("blocks when the allowance is already spent", () => {
  const verdict = evaluateActionsBudget({ includedMinutes: 2_000, usedMinutes: 2_400 });
  assert.equal(verdict.decision, "block");
  assert.equal(verdict.remaining, 0, "overage must not read as negative headroom");
});

test("treats the boundary as allowed, not blocked", () => {
  // Exactly enough: remaining - run == reserve. Blocking here would be off by
  // one against the operator for no reason.
  const verdict = evaluateActionsBudget({
    includedMinutes: 2_000,
    usedMinutes: 2_000 - (DEFAULT_ESTIMATED_RUN_MINUTES + DEFAULT_RESERVE_MINUTES),
  });
  assert.equal(verdict.decision, "allow");
});

test("allows freely when no metered allowance applies", () => {
  // Public repositories and some paid plans report zero included minutes.
  // Reading that as "no budget left" would block every run forever.
  const verdict = evaluateActionsBudget({ includedMinutes: 0, usedMinutes: 50_000 });
  assert.equal(verdict.decision, "allow");
  assert.match(verdict.reason, /No metered Actions allowance/u);
});

test("reports unknown rather than guessing when usage is unreadable", () => {
  for (const input of [{}, { includedMinutes: 2_000 }, { usedMinutes: 10 }, { includedMinutes: NaN, usedMinutes: 10 }]) {
    assert.equal(evaluateActionsBudget(input).decision, "unknown", JSON.stringify(input));
  }
});

test("honours a custom run estimate and reserve", () => {
  // A hosted-API run is minutes, not hours, so the same headroom that blocks
  // a CPU run should comfortably allow a short one.
  const headroom = { includedMinutes: 2_000, usedMinutes: 1_650 };
  assert.equal(evaluateActionsBudget({ ...headroom, estimatedRunMinutes: 3, reserveMinutes: 300 }).decision, "allow");
  assert.equal(evaluateActionsBudget({ ...headroom, estimatedRunMinutes: 3, reserveMinutes: 349 }).decision, "block");
});

test("states the numbers it decided on, not just the verdict", () => {
  // An operator who disagrees has to be able to check the arithmetic without
  // reading the source.
  const verdict = evaluateActionsBudget({ includedMinutes: 2_000, usedMinutes: 1_900 });
  assert.match(verdict.reason, /1900 of 2000 minutes used/u);
  assert.match(verdict.reason, /100 remaining/u);
  assert.match(verdict.reason, /about 120/u);
});

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { budgetVerdict, runBudgetCheck } from "./actions-budget.mjs";
import { renderResult } from "./report-result.mjs";

test("unknown usage blocks by default, including malformed billing values", () => {
  for (const usage of [{}, { error: "403" }, { includedMinutes: null, usedMinutes: null }, { includedMinutes: "2000", usedMinutes: 0 }, { includedMinutes: -1, usedMinutes: 0 }]) {
    assert.equal(budgetVerdict(usage).decision, "unknown");
    assert.equal(budgetVerdict(usage).action, "block");
  }
});

test("explicit allow preserves UNKNOWN but cannot bypass a known exhausted budget", () => {
  const env = { ATLAS_ACTIONS_UNKNOWN_POLICY: "allow" };
  assert.deepEqual(budgetVerdict({}, env), { decision: "unknown", reason: "Actions usage could not be read.", action: "allow" });
  assert.equal(budgetVerdict({ includedMinutes: 2000, usedMinutes: 2000 }, env).action, "block");
  assert.equal(budgetVerdict({}, { ATLAS_ACTIONS_UNKNOWN_POLICY: "alow" }).action, "block");
});

test("a failed probe produces a blocked task and an UNKNOWN hosted result", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-budget-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  assert.equal(runBudgetCheck({ ATLAS_OUTPUT_DIR: directory }, () => { throw new Error("private failure"); }), 1);
  const budget = JSON.parse(fs.readFileSync(path.join(directory, "budget.json"), "utf8"));
  const status = JSON.parse(fs.readFileSync(path.join(directory, "status.json"), "utf8"));
  assert.equal(status.status, "blocked");
  const summary = renderResult({ budget, status, conclusion: "failure" });
  assert.match(summary, /UNKNOWN/u);
  assert.doesNotMatch(summary, /private failure/u);
});

test("allowed unknown usage survives a later successful task result", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-budget-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  assert.equal(runBudgetCheck({ ATLAS_OUTPUT_DIR: directory, ATLAS_ACTIONS_UNKNOWN_POLICY: "allow" }, () => ({})), 0);
  const budget = JSON.parse(fs.readFileSync(path.join(directory, "budget.json"), "utf8"));
  assert.equal(fs.existsSync(path.join(directory, "status.json")), false);
  assert.match(renderResult({ budget, status: { status: "completed" } }), /Actions budget: \*\*UNKNOWN\*\* — allow/u);
});

test("the actual CLI exits nonzero without billing credentials", () => {
  const result = spawnSync(process.execPath, ["scripts/runner/actions-budget.mjs"], {
    encoding: "utf8", windowsHide: true,
    env: { ...process.env, GH_TOKEN: "", ATLAS_BILLING_ACCOUNT: "", ATLAS_OUTPUT_DIR: "", ATLAS_ACTIONS_UNKNOWN_POLICY: "" },
  });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /Actions budget UNKNOWN/u);
});
