import type { SessionAuditLog, SessionEvent } from "../domain/session-audit.js";
import type { JsonLinesSessionAuditStore } from "./json-lines-session-audit-store.js";

export interface PersistSessionAuditResult {
  readonly persisted: number;
  /** Present when persistence failed; the run itself is unaffected. */
  readonly error?: string;
}

/**
 * Flushes a completed session's in-memory audit log to durable storage.
 *
 * Written as a flush rather than by making the agent append straight to the
 * store, because the agent records events synchronously in the middle of a
 * turn and the store is asynchronous. Turning every append into an awaited
 * disk write would put file I/O on the critical path of the agent loop and
 * change ordering guarantees the agent relies on, to persist a record nobody
 * reads until the run is over.
 *
 * Each event keeps its original timestamp, so durations and ordering survive
 * the flush instead of collapsing into the instant the file was written.
 *
 * NEVER throws. A run that produced a correct change and a pull request has
 * not failed because its audit trail could not be written to disk, so the
 * failure is reported to the caller rather than raised — losing the record is
 * bad, but discarding the work is worse.
 */
export async function persistSessionAudit(
  store: JsonLinesSessionAuditStore,
  audit: SessionAuditLog,
): Promise<PersistSessionAuditResult> {
  const events: readonly SessionEvent[] = audit.snapshot();
  let persisted = 0;
  try {
    for (const event of events) {
      await store.append(event.type, event.payload, event.occurredAt);
      persisted += 1;
    }
    return { persisted };
  } catch (error: unknown) {
    // Reports how many landed, not just that it broke: an append-only log that
    // stops half way is still a usable partial record, and the caller should be
    // able to say so accurately.
    return {
      persisted,
      error: error instanceof Error ? error.message : "Audit persistence failed.",
    };
  }
}
