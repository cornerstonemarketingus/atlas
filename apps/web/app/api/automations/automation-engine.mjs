import { cronMatches, githubFailureMatches } from "./automation-rules.mjs";

export function budgetCutoffIso(now, budgetWindowDays) {
  const value = now instanceof Date ? now : new Date(now);
  return new Date(value.getTime() - budgetWindowDays * 24 * 60 * 60 * 1000).toISOString();
}

export function shouldRunAutomation(automation, trigger, now) {
  if (automation.pausedAt) return { run: false, status: "paused", reason: "Automation is paused." };
  if (trigger.kind === "cron") {
    const cron = automation.trigger?.cron;
    if (!cronMatches(cron, now)) return { run: false, status: "skipped", reason: "Cron does not match this tick." };
    return { run: true };
  }
  if (trigger.kind === "github.check-failed") {
    if (!githubFailureMatches(automation.trigger, trigger)) return { run: false, status: "skipped", reason: "GitHub event does not match trigger." };
    return { run: true };
  }
  return { run: false, status: "skipped", reason: "Unsupported trigger." };
}

export function dedupeKeyForTrigger(trigger, now) {
  if (trigger.kind === "cron") {
    const value = now instanceof Date ? now : new Date(now);
    const minute = new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate(), value.getUTCHours(), value.getUTCMinutes(), 0, 0));
    return `cron:${minute.toISOString()}`;
  }
  if (trigger.kind === "github.check-failed") return `gh:${trigger.deliveryId ?? ""}:${trigger.repository}:${trigger.branch}:${trigger.checkName ?? ""}`;
  return null;
}
