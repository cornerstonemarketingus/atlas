import type { SessionEvent } from "../domain/session-audit.js";

/**
 * Reconstructs what an agent session did, from its audit trace.
 *
 * Traces have been written since the audit log landed and nothing has ever
 * read one back. That gap is about to get expensive: a single agent's failure
 * is a log you can read top to bottom, but several cooperating agents produce
 * interleaved traces, and the only question that matters — which step made the
 * bad decision, on what evidence — cannot be answered by scrolling. This is
 * the reader.
 *
 * WHAT THIS CAN AND CANNOT SHOW. The trace records digests, not content:
 * `contentDigest`, `argumentsDigest`, `resultDigest`. So a reconstruction
 * recovers the SHAPE of a session — which tools were called in which order,
 * what policy decided, what failed, how long each step took, where the tokens
 * went — and never the literal prompt text. That is deliberate: traces are
 * redacted and digested precisely so they can be kept and shared. This is not
 * re-execution either; nothing here replays a session against a model.
 *
 * Correlation is by `requestId` for turns and `toolCallId` for tool calls.
 *
 * UNFINISHED WORK STAYS VISIBLE. A trace that stops mid-turn is exactly the
 * one worth reading, so a turn with no response, or a tool call with no
 * result, is reported as unfinished rather than dropped. "Called
 * repository.search and never got a result" is the single most diagnostic
 * fact such a trace contains, and discarding it to keep the model tidy would
 * throw away the reason someone opened the file.
 */

export type ReplayOutcome = "completed" | "blocked" | "failed" | "unfinished";

export interface ReplayToolCall {
  readonly toolCallId: string;
  readonly toolId: string;
  readonly requestedAt: string;
  readonly decision?: "allow" | "ask" | "deny";
  readonly policyReason?: string;
  readonly outcome?: "succeeded" | "failed" | "cancelled";
  readonly durationMs?: number;
  readonly errorCode?: string;
  /** True when the trace records a request with no result. */
  readonly unfinished: boolean;
}

export interface ReplayTurn {
  readonly index: number;
  readonly requestId: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly startedAt: string;
  readonly messageCount: number;
  readonly inputCharacters: number;
  readonly toolsOffered: number;
  readonly respondedAt?: string;
  readonly finishReason?: string;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly toolCalls: readonly ReplayToolCall[];
  /** True when the trace records a request with no response. */
  readonly unfinished: boolean;
}

export interface ReplayError {
  readonly at: string;
  readonly code: string;
  readonly summary: string;
  readonly recoverable: boolean;
}

export interface ReplaySession {
  readonly sessionId: string;
  readonly repositoryId?: string;
  readonly startedAt?: string;
  readonly endedAt?: string;
  readonly durationMs?: number;
  readonly outcome: ReplayOutcome;
  readonly summary?: string;
  readonly turns: readonly ReplayTurn[];
  readonly errors: readonly ReplayError[];
  readonly totals: {
    readonly turns: number;
    readonly toolCalls: number;
    readonly unfinishedToolCalls: number;
    readonly inputTokens: number;
    readonly outputTokens: number;
  };
}

const TERMINAL: Record<string, ReplayOutcome> = {
  "session.completed": "completed",
  "session.blocked": "blocked",
  "session.failed": "failed",
};

interface Draft {
  sessionId: string;
  repositoryId?: string | undefined;
  startedAt?: string | undefined;
  endedAt?: string | undefined;
  outcome: ReplayOutcome;
  summary?: string;
  turns: Map<string, MutableTurn>;
  turnOrder: string[];
  toolIndex: Map<string, MutableToolCall>;
  errors: ReplayError[];
}

/**
 * Working copies. Deriving these with Omit<> from the public types keeps the
 * readonly modifiers, which is right for what callers receive and wrong for
 * what this file assembles, so they are written out.
 */
interface MutableTurn {
  requestId: string;
  providerId: string;
  modelId: string;
  startedAt: string;
  messageCount: number;
  inputCharacters: number;
  toolsOffered: number;
  respondedAt?: string | undefined;
  finishReason?: string | undefined;
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  toolCalls: MutableToolCall[];
}

interface MutableToolCall {
  toolCallId: string;
  toolId: string;
  requestedAt: string;
  decision?: "allow" | "ask" | "deny" | undefined;
  policyReason?: string | undefined;
  outcome?: "succeeded" | "failed" | "cancelled" | undefined;
  durationMs?: number | undefined;
  errorCode?: string | undefined;
}

function field(payload: unknown, key: string): unknown {
  return typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>)[key] : undefined;
}

function text(payload: unknown, key: string): string | undefined {
  const value = field(payload, key);
  return typeof value === "string" ? value : undefined;
}

function number(payload: unknown, key: string): number | undefined {
  const value = field(payload, key);
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Groups a trace into sessions and reconstructs each.
 *
 * One file can hold several sessions: the store is append-only, and a repeated
 * flush is the normal case rather than an error. Events belonging to no
 * declared session are still reconstructed under a synthetic one, because a
 * trace whose opening event was lost is not a trace worth discarding.
 */
export function reconstructSessions(events: readonly SessionEvent[]): readonly ReplaySession[] {
  const drafts: Draft[] = [];
  let current: Draft | undefined;

  const ensure = (): Draft => {
    const existing = current;
    if (existing !== undefined) return existing;
    {
      const created: Draft = {
        sessionId: "(unknown session)",
        outcome: "unfinished",
        turns: new Map(),
        turnOrder: [],
        toolIndex: new Map(),
        errors: [],
      };
      drafts.push(created);
      current = created;
      return created;
    }
  };

  for (const event of [...events].sort((left, right) => left.sequence - right.sequence)) {
    const payload = event.payload as unknown;

    if (event.type === "session.started") {
      const started: Draft = {
        sessionId: text(payload, "sessionId") ?? "(unknown session)",
        repositoryId: text(payload, "repositoryId"),
        startedAt: event.occurredAt,
        outcome: "unfinished",
        turns: new Map(),
        turnOrder: [],
        toolIndex: new Map(),
        errors: [],
      };
      drafts.push(started);
      current = started;
      continue;
    }

    const draft = ensure();

    if (event.type in TERMINAL) {
      draft.outcome = TERMINAL[event.type] as ReplayOutcome;
      draft.endedAt = event.occurredAt;
      const summary = text(payload, "summary");
      if (summary !== undefined) draft.summary = summary;
      // A terminal event closes this session; anything after it starts a new
      // one, so the next event must not be folded into a finished session.
      current = undefined;
      continue;
    }

    if (event.type === "model.requested") {
      const requestId = text(payload, "requestId") ?? `turn-${draft.turnOrder.length + 1}`;
      draft.turns.set(requestId, {
        requestId,
        providerId: text(payload, "providerId") ?? "(unknown)",
        modelId: text(payload, "modelId") ?? "(unknown)",
        startedAt: event.occurredAt,
        messageCount: number(payload, "messageCount") ?? 0,
        inputCharacters: number(payload, "inputCharacters") ?? 0,
        toolsOffered: number(payload, "toolsOffered") ?? 0,
        toolCalls: [],
      });
      draft.turnOrder.push(requestId);
      continue;
    }

    if (event.type === "model.responded") {
      const turn = draft.turns.get(text(payload, "requestId") ?? "");
      if (turn) {
        turn.respondedAt = event.occurredAt;
        turn.finishReason = text(payload, "finishReason");
        turn.inputTokens = number(payload, "inputTokens");
        turn.outputTokens = number(payload, "outputTokens");
      }
      continue;
    }

    if (event.type === "tool.requested") {
      const toolCallId = text(payload, "toolCallId") ?? `call-${draft.toolIndex.size + 1}`;
      const call: MutableToolCall = {
        toolCallId,
        toolId: text(payload, "toolId") ?? "(unknown tool)",
        requestedAt: event.occurredAt,
      };
      draft.toolIndex.set(toolCallId, call);
      // Attach to its turn when the trace says which; otherwise to the most
      // recent one, which is where it happened.
      const turn = draft.turns.get(text(payload, "requestId") ?? "")
        ?? draft.turns.get(draft.turnOrder[draft.turnOrder.length - 1] ?? "");
      turn?.toolCalls.push(call);
      continue;
    }

    if (event.type === "tool.policy_decided") {
      const call = draft.toolIndex.get(text(payload, "toolCallId") ?? "");
      if (call) {
        const decision = text(payload, "decision");
        Object.assign(call, {
          ...(decision === undefined ? {} : { decision }),
          ...(text(payload, "reason") === undefined ? {} : { policyReason: text(payload, "reason") }),
        });
      }
      continue;
    }

    if (event.type === "tool.completed") {
      const call = draft.toolIndex.get(text(payload, "toolCallId") ?? "");
      if (call) {
        Object.assign(call, {
          outcome: text(payload, "outcome"),
          durationMs: number(payload, "durationMs"),
          ...(text(payload, "errorCode") === undefined ? {} : { errorCode: text(payload, "errorCode") }),
        });
      }
      continue;
    }

    if (event.type === "error.recorded") {
      draft.errors.push({
        at: event.occurredAt,
        code: text(payload, "code") ?? "(unknown)",
        summary: text(payload, "summary") ?? "",
        recoverable: field(payload, "recoverable") === true,
      });
    }
  }

  return drafts.map(finalize);
}

function finalize(draft: Draft): ReplaySession {
  const turns: ReplayTurn[] = draft.turnOrder.map((requestId, position) => {
    const turn = draft.turns.get(requestId);
    if (turn === undefined) throw new Error(`Turn ${requestId} vanished during reconstruction.`);
    // Built field by field rather than spread: the public type marks these
    // optional under exactOptionalPropertyTypes, so an explicit `undefined`
    // is a different thing from an absent key and will not assign.
    return {
      index: position + 1,
      requestId: turn.requestId,
      providerId: turn.providerId,
      modelId: turn.modelId,
      startedAt: turn.startedAt,
      messageCount: turn.messageCount,
      inputCharacters: turn.inputCharacters,
      toolsOffered: turn.toolsOffered,
      ...(turn.respondedAt === undefined ? {} : { respondedAt: turn.respondedAt }),
      ...(turn.finishReason === undefined ? {} : { finishReason: turn.finishReason }),
      ...(turn.inputTokens === undefined ? {} : { inputTokens: turn.inputTokens }),
      ...(turn.outputTokens === undefined ? {} : { outputTokens: turn.outputTokens }),
      unfinished: turn.respondedAt === undefined,
      toolCalls: turn.toolCalls.map((call) => ({
        toolCallId: call.toolCallId,
        toolId: call.toolId,
        requestedAt: call.requestedAt,
        ...(call.decision === undefined ? {} : { decision: call.decision }),
        ...(call.policyReason === undefined ? {} : { policyReason: call.policyReason }),
        ...(call.outcome === undefined ? {} : { outcome: call.outcome }),
        ...(call.durationMs === undefined ? {} : { durationMs: call.durationMs }),
        ...(call.errorCode === undefined ? {} : { errorCode: call.errorCode }),
        unfinished: call.outcome === undefined,
      })),
    };
  });

  const allCalls = turns.flatMap((turn) => turn.toolCalls);
  const durationMs = draft.startedAt !== undefined && draft.endedAt !== undefined
    ? Math.max(0, Date.parse(draft.endedAt) - Date.parse(draft.startedAt))
    : undefined;

  return {
    sessionId: draft.sessionId,
    ...(draft.repositoryId === undefined ? {} : { repositoryId: draft.repositoryId }),
    ...(draft.startedAt === undefined ? {} : { startedAt: draft.startedAt }),
    ...(draft.endedAt === undefined ? {} : { endedAt: draft.endedAt }),
    ...(durationMs === undefined || Number.isNaN(durationMs) ? {} : { durationMs }),
    outcome: draft.outcome,
    ...(draft.summary === undefined ? {} : { summary: draft.summary }),
    turns,
    errors: draft.errors,
    totals: {
      turns: turns.length,
      toolCalls: allCalls.length,
      unfinishedToolCalls: allCalls.filter((call) => call.unfinished).length,
      inputTokens: turns.reduce((total, turn) => total + (turn.inputTokens ?? 0), 0),
      outputTokens: turns.reduce((total, turn) => total + (turn.outputTokens ?? 0), 0),
    },
  };
}
