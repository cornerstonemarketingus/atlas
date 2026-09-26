import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { getDb } from "../../../db";
import { automationRuns, automations } from "../../../db/schema";
import { budgetCutoffIso, dedupeKeyForTrigger, shouldRunAutomation } from "./automation-engine.mjs";
import { dispatchTaskForAccount } from "../tasks/dispatch-core.mjs";

export type AutomationTrigger =
  | { kind: "cron" }
  | { kind: "github.check-failed"; repository: string; branch: string; checkName: string; eventId?: string | null; deliveryId?: string | null };

function parseTrigger(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

export async function runAutomations(trigger: AutomationTrigger, now = new Date(), environment = process.env) {
  const db = getDb();
  const rows = await db.select().from(automations).orderBy(desc(automations.createdAt));
  const runs: Array<{ automationId: string; status: string; taskId: string | null; reason: string | null }> = [];
  for (const row of rows) {
    const triggerConfig = parseTrigger(row.triggerConfig);
    if (!triggerConfig) continue;
    if (trigger.kind === "github.check-failed" && trigger.repository.toLowerCase() !== row.repository.toLowerCase()) continue;
    const evaluation = shouldRunAutomation({ pausedAt: row.pausedAt, trigger: triggerConfig }, trigger, now);
    const dedupeKey = dedupeKeyForTrigger(trigger, now);
    if (!evaluation.run) {
      // Record paused outcomes in history so users can see the skipped trigger.
      if (evaluation.status !== "paused") continue;
      await db.insert(automationRuns).values({
        id: randomUUID(),
        automationId: row.id,
        requestedBy: row.requestedBy,
        status: evaluation.status,
        reason: evaluation.reason ?? null,
        taskId: null,
        dedupeKey,
        triggeredAt: now.toISOString(),
      }).onConflictDoNothing();
      runs.push({ automationId: row.id, status: evaluation.status, taskId: null, reason: evaluation.reason ?? null });
      continue;
    }

    const reserved = await db.insert(automationRuns).values({
      id: randomUUID(),
      automationId: row.id,
      requestedBy: row.requestedBy,
      status: "reserved",
      reason: "Run reserved for trigger dedupe.",
      taskId: null,
      dedupeKey,
      triggeredAt: now.toISOString(),
    }).onConflictDoNothing().returning({ id: automationRuns.id });
    if (reserved.length === 0) continue;
    const reservedRunId = reserved[0].id;

    const budgetCutoff = budgetCutoffIso(now, row.budgetWindowDays);
    const slot = await db.update(automationRuns).set({ status: "dispatching", reason: "Dispatching task.", triggeredAt: now.toISOString() })
      .where(and(
        eq(automationRuns.id, reservedRunId),
        sql`(SELECT COUNT(1) FROM ${automationRuns}
            WHERE ${automationRuns.automationId} = ${row.id}
              AND ${automationRuns.status} IN ('started', 'dispatching', 'reserved')
              AND ${automationRuns.id} != ${reservedRunId}
              AND ${automationRuns.triggeredAt} >= ${budgetCutoff}) < ${row.budgetLimit}`,
      ))
      .returning({ id: automationRuns.id });
    if (slot.length === 0) {
      await db.update(automationRuns)
        .set({ status: "budget_exceeded", reason: `Budget ${row.budgetLimit}/${row.budgetWindowDays}d reached.`, taskId: null, triggeredAt: now.toISOString() })
        .where(eq(automationRuns.id, reservedRunId));
      runs.push({ automationId: row.id, status: "budget_exceeded", taskId: null, reason: `Budget ${row.budgetLimit}/${row.budgetWindowDays}d reached.` });
      continue;
    }

    const dispatchBranch = trigger.kind === "github.check-failed"
      ? (typeof triggerConfig.branch === "string" && triggerConfig.branch ? triggerConfig.branch : row.branch)
      : row.branch;
    const response = await dispatchTaskForAccount(
      { userId: row.requestedBy, dbUserId: row.userId },
      {
        repository: row.repository,
        branch: dispatchBranch,
        mode: row.mode,
        objective: row.objective,
        conversationId: stableConversationId(row.id),
      },
      null,
      environment,
    );
    let payload: { taskId?: unknown; message?: unknown } = {};
    try { payload = await response.json() as { taskId?: unknown; message?: unknown }; } catch { payload = {}; }
    const started = response.status === 202 && typeof payload.taskId === "string";
    const status = started ? "started" : "dispatch_failed";
    const reason = started ? null : (typeof payload.message === "string" ? payload.message : `Dispatch failed with ${response.status}.`);
    const taskId = started ? payload.taskId : null;
    await db.update(automationRuns)
      .set({ status, reason, taskId, triggeredAt: now.toISOString() })
      .where(eq(automationRuns.id, reservedRunId));
    runs.push({ automationId: row.id, status, taskId, reason });
  }
  return runs;
}

function stableConversationId(automationId: string) {
  const digest = createHash("sha256").update(automationId).digest("hex").slice(0, 32);
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20, 32)}`;
}

export function automationView(row: typeof automations.$inferSelect, runs: Array<typeof automationRuns.$inferSelect>) {
  return {
    id: row.id,
    name: row.name,
    repository: row.repository,
    branch: row.branch,
    mode: row.mode,
    objective: row.objective,
    triggerType: row.triggerType,
    trigger: parseTrigger(row.triggerConfig),
    budgetLimit: row.budgetLimit,
    budgetWindowDays: row.budgetWindowDays,
    paused: row.pausedAt !== null,
    pausedAt: row.pausedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    runs: runs.map((run) => ({ id: run.id, status: run.status, reason: run.reason, taskId: run.taskId, triggeredAt: run.triggeredAt })),
  };
}
