import assert from "node:assert/strict";
import test from "node:test";
import { budgetCutoffIso, dedupeKeyForTrigger, shouldRunAutomation } from "../app/api/automations/automation-engine.mjs";
import { cronMatches, validateAutomation } from "../app/api/automations/automation-rules.mjs";

test("accepts a weekly cron automation payload", () => {
  const result = validateAutomation({
    name: "Weekly dependency update",
    repository: "cornerstonemarketingus/atlas",
    branch: "main",
    mode: "debug",
    objective: "Update dependencies every Monday.",
    triggerType: "cron",
    trigger: { cron: "0 9 * * 1" },
    budgetLimit: 2,
    budgetWindowDays: 7,
  }, new Set(["cornerstonemarketingus/atlas"]));
  assert.equal("error" in result, false);
  assert.equal(result.automation.trigger.cron, "0 9 * * 1");
});

test("rejects incompatible trigger fields", () => {
  const allowlist = new Set(["cornerstonemarketingus/atlas"]);
  const cronWithBranch = validateAutomation({
    name: "Weekly dependency update",
    repository: "cornerstonemarketingus/atlas",
    branch: "main",
    mode: "debug",
    objective: "Update dependencies every Monday.",
    triggerType: "cron",
    trigger: { cron: "0 9 * * 1", branch: "main" },
    budgetLimit: 2,
    budgetWindowDays: 7,
  }, allowlist);
  assert.equal(cronWithBranch.status, 400);
  const githubWithCron = validateAutomation({
    name: "CI failure follow-up",
    repository: "cornerstonemarketingus/atlas",
    branch: "main",
    mode: "debug",
    objective: "Investigate CI failures.",
    triggerType: "github-check-failure",
    trigger: { branch: "main", cron: "0 9 * * 1" },
    budgetLimit: 1,
    budgetWindowDays: 7,
  }, allowlist);
  assert.equal(githubWithCron.status, 400);
});

test("matches weekly cron schedules in UTC", () => {
  assert.equal(cronMatches("0 9 * * 1", new Date("2026-09-28T09:00:00.000Z")), true);
  assert.equal(cronMatches("0 9 * * 1", new Date("2026-09-28T09:01:00.000Z")), false);
  assert.equal(cronMatches("0 9 1 * 1", new Date("2026-09-01T09:00:00.000Z")), true, "day-of-month and day-of-week restricted should be OR");
  assert.equal(cronMatches("0 9 * * 7", new Date("2026-09-27T09:00:00.000Z")), true, "7 aliases Sunday");
});

test("matches CI failure events on main", () => {
  const run = shouldRunAutomation(
    { pausedAt: null, trigger: { branch: "main", checkName: "CI" } },
    { kind: "github.check-failed", repository: "cornerstonemarketingus/atlas", branch: "main", checkName: "CI" },
    new Date(),
  );
  assert.equal(run.run, true);
});

test("paused automations do not run and produce a stable dedupe key", () => {
  const now = new Date("2026-09-28T09:00:42.000Z");
  const run = shouldRunAutomation({ pausedAt: "2026-09-28T08:00:00.000Z", trigger: { cron: "* * * * *" } }, { kind: "cron" }, now);
  assert.deepEqual(run, { run: false, status: "paused", reason: "Automation is paused." });
  assert.equal(dedupeKeyForTrigger({ kind: "cron" }, now), "cron:2026-09-28T09:00:00.000Z");
});

test("non-matching cron ticks are skipped", () => {
  const run = shouldRunAutomation({ pausedAt: null, trigger: { cron: "0 9 * * 1" } }, { kind: "cron" }, new Date("2026-09-28T10:00:00.000Z"));
  assert.deepEqual(run, { run: false, status: "skipped", reason: "Cron does not match this tick." });
});

test("event dedupe key falls back to event id when delivery id is absent", () => {
  assert.equal(
    dedupeKeyForTrigger({ kind: "github.check-failed", repository: "cornerstonemarketingus/atlas", branch: "main", checkName: "CI", eventId: "101" }),
    "gh:101:cornerstonemarketingus/atlas:main:CI",
  );
});

test("budget cutoff calculates a sliding window boundary", () => {
  assert.equal(budgetCutoffIso(new Date("2026-09-28T09:00:00.000Z"), 7), "2026-09-21T09:00:00.000Z");
});
