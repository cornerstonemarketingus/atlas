import { randomUUID } from "node:crypto";
import { computerTaskEvents } from "../../../db/schema";

export function taskEvent(taskId: string, requestedBy: string, kind: string, summary: string, detail?: string | null) {
  return {
    id: randomUUID(), taskId, requestedBy, kind,
    summary: summary.slice(0, 240),
    detail: detail ? detail.slice(0, 2000) : null,
    createdAt: new Date().toISOString(),
  } satisfies typeof computerTaskEvents.$inferInsert;
}

export const OPERATOR_LEASE_MS = 3 * 60 * 1000;

export function leaseDeadline(now = Date.now()) {
  return new Date(now + OPERATOR_LEASE_MS).toISOString();
}
