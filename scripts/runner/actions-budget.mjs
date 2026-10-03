/** Actions allowance guard. UNKNOWN blocks by default; explicit allow preserves the unknown verdict. */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Conservative reservation in minutes, configurable for the workload. */
export const DEFAULT_ESTIMATED_RUN_MINUTES = 120;
/** Minutes deliberately held back so ordinary CI still works. */
export const DEFAULT_RESERVE_MINUTES = 300;

/**
 * Pure: decides whether a run of this size should start.
 *
 * Separated from the API call so the arithmetic — which is the part that can
 * be wrong in an expensive way — is testable without a network or a token.
 */
export function evaluateActionsBudget({
  includedMinutes,
  usedMinutes,
  estimatedRunMinutes = DEFAULT_ESTIMATED_RUN_MINUTES,
  reserveMinutes = DEFAULT_RESERVE_MINUTES,
} = {}) {
  if (!Number.isFinite(includedMinutes) || !Number.isFinite(usedMinutes) || includedMinutes < 0 || usedMinutes < 0) {
    return { decision: "unknown", reason: "Actions usage could not be read." };
  }
  // A plan with unlimited minutes (public repositories, some paid plans)
  // reports zero included minutes. There is nothing to protect.
  if (includedMinutes <= 0) {
    return { decision: "allow", reason: "No metered Actions allowance applies." };
  }

  const remaining = Math.max(0, includedMinutes - usedMinutes);
  const afterRun = remaining - estimatedRunMinutes;
  const detail = `${usedMinutes} of ${includedMinutes} minutes used, ${remaining} remaining; this run needs about ${estimatedRunMinutes}.`;

  if (afterRun < reserveMinutes) {
    return {
      decision: "block",
      remaining,
      reason: `${detail} That would leave ${Math.max(0, afterRun)} against a ${reserveMinutes}-minute reserve kept for CI.`,
    };
  }
  return { decision: "allow", remaining, reason: detail };
}

function positiveInteger(raw, fallback) {
  const value = String(raw ?? "").trim();
  if (value.length === 0 || !/^\d+$/u.test(value)) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Reads the account's Actions usage.
 *
 * Returns unavailable usage on failure; the caller applies the unknown policy.
 */
function readUsage(token, account) {
  if (!token || !account) return { includedMinutes: null, usedMinutes: null, error: "No token or account available." };
  const result = spawnSync("curl", [
    "-sS", "--fail-with-body", "--max-time", "30",
    "-H", `Authorization: Bearer ${token}`,
    "-H", "Accept: application/vnd.github+json",
    `https://api.github.com/users/${encodeURIComponent(account)}/settings/billing/actions`,
  ], { encoding: "utf8", windowsHide: true });

  if (result.error || result.status !== 0) {
    return { includedMinutes: null, usedMinutes: null, error: "Billing request failed or was not authorized." };
  }
  try {
    const parsed = JSON.parse(result.stdout);
    return {
      includedMinutes: parsed?.included_minutes,
      usedMinutes: parsed?.total_minutes_used,
      error: null,
    };
  } catch {
    return { includedMinutes: null, usedMinutes: null, error: "Unparseable billing response." };
  }
}

export function budgetVerdict(usage, environment = {}) {
  const unknownPolicy = environment.ATLAS_ACTIONS_UNKNOWN_POLICY?.trim() || "block";
  if (!["block", "allow"].includes(unknownPolicy)) {
    return { decision: "unknown", action: "block", reason: "Invalid ATLAS_ACTIONS_UNKNOWN_POLICY; expected block or allow." };
  }
  const verdict = evaluateActionsBudget({
    ...usage,
    ...(usage.error ? { includedMinutes: null, usedMinutes: null } : {}),
    estimatedRunMinutes: positiveInteger(environment.ATLAS_ESTIMATED_RUN_MINUTES, DEFAULT_ESTIMATED_RUN_MINUTES),
    reserveMinutes: positiveInteger(environment.ATLAS_ACTIONS_MINUTES_RESERVE, DEFAULT_RESERVE_MINUTES),
  });
  return { ...verdict, action: verdict.decision === "unknown" ? unknownPolicy : verdict.decision };
}

export function runBudgetCheck(environment = process.env, read = readUsage) {
  let usage;
  try { usage = read(environment.GH_TOKEN, environment.ATLAS_BILLING_ACCOUNT); }
  catch { usage = { error: "Billing request failed." }; }
  const verdict = budgetVerdict(usage ?? {}, environment);
  const message = "Actions budget " + verdict.decision.toUpperCase() + ": " + verdict.reason + " Policy: " + verdict.action + ".";
  console.log(message);
  const directory = environment.ATLAS_OUTPUT_DIR;
  if (directory) {
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, "budget.json"), JSON.stringify(verdict, null, 2));
    if (verdict.action === "block") {
      fs.writeFileSync(path.join(directory, "status.json"), JSON.stringify({ status: "blocked", message }, null, 2));
    }
  }
  return verdict.action === "block" ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = runBudgetCheck(); }
  catch {
    console.error("Actions budget UNKNOWN: guard failed; refusing to start.");
    process.exitCode = 1;
  }
}
