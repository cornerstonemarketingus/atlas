/**
 * Refuses to start a long self-hosted run when it would eat the month's
 * GitHub Actions allowance.
 *
 * A hosted-API coder run takes one to three minutes. A self-hosted run on the
 * runner's CPU takes one to two HOURS, and on a private repository those
 * minutes are billed past the free allowance. Thirty of them is the whole
 * monthly budget with nothing left for CI. The failure this prevents is not a
 * broken run — it is a surprise invoice, and the owner finding out about it
 * after the fact.
 *
 * FAILS OPEN, deliberately. If the budget cannot be read — no token, no
 * billing permission, API down — the run proceeds and the reason is printed.
 * The alternative is a permissions gap silently blocking every run, which
 * would get this guard switched off within a week, and a guard that is off
 * protects nothing. An unreadable budget is reported loudly rather than
 * treated as empty.
 */

import { spawnSync } from "node:child_process";

/** A CPU run's realistic wall time, in minutes. Overridable. */
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
  if (!Number.isFinite(includedMinutes) || !Number.isFinite(usedMinutes)) {
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
 * Returns nulls rather than throwing on any failure: the caller's job is to
 * proceed and say why it could not check, not to stop.
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
    const body = (result.stdout ?? "").trim();
    return { includedMinutes: null, usedMinutes: null, error: body || result.error?.message || `curl exit ${result.status}` };
  }
  try {
    const parsed = JSON.parse(result.stdout);
    return {
      includedMinutes: Number(parsed.included_minutes),
      usedMinutes: Number(parsed.total_minutes_used),
      error: null,
    };
  } catch (error) {
    return { includedMinutes: null, usedMinutes: null, error: `Unparseable billing response: ${error.message}` };
  }
}

function main() {
  const estimatedRunMinutes = positiveInteger(process.env.ATLAS_ESTIMATED_RUN_MINUTES, DEFAULT_ESTIMATED_RUN_MINUTES);
  const reserveMinutes = positiveInteger(process.env.ATLAS_ACTIONS_MINUTES_RESERVE, DEFAULT_RESERVE_MINUTES);

  const usage = readUsage(process.env.GH_TOKEN, process.env.ATLAS_BILLING_ACCOUNT);
  if (usage.error) {
    console.log("Actions budget not checked, so this run proceeds.");
    console.log(`Reason: ${usage.error}`);
    console.log("To enable the check, the token needs read access to the account's plan/billing.");
    return 0;
  }

  const verdict = evaluateActionsBudget({ ...usage, estimatedRunMinutes, reserveMinutes });
  if (verdict.decision === "block") {
    console.error(`Refusing to start: ${verdict.reason}`);
    console.error("Raise ATLAS_ACTIONS_MINUTES_RESERVE, or wait for the allowance to reset, or use a hosted model (a run costs minutes, not hours).");
    return 1;
  }
  console.log(`Actions budget OK. ${verdict.reason}`);
  return 0;
}

if (process.argv[1] && process.argv[1].endsWith("actions-budget.mjs")) {
  let code = 0;
  try {
    code = main();
  } catch (error) {
    // A broken guard must not block work it was meant to protect.
    console.log(`Actions budget check failed (${error?.message ?? error}); proceeding.`);
    code = 0;
  }
  process.exit(code);
}
