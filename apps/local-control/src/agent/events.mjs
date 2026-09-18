/**
 * The normalized event contract every Atlas executor speaks.
 *
 * Clients reconnect by sequence number, so the shape of an event is a
 * published interface: a field removed here breaks a phone that was offline
 * when the event was written. Add fields; do not repurpose them.
 */
export const AGENT_EVENT_SCHEMA_VERSION = 1;

export const AGENT_EVENT_KINDS = [
  "status",
  "assistant_message",
  "tool_proposal",
  "tool_execution",
  "validation_result",
  "approval_request",
  "artifact",
  "error",
  "completion",
];

/** Terminal for the run, though the session itself stays resumable. */
export const AGENT_SESSION_STATUSES = [
  "idle",
  "queued",
  "running",
  "paused",
  "awaiting_approval",
  "cancelled",
  "interrupted",
  "completed",
  "failed",
];

const MAX_EVENT_BYTES = 64 * 1024;

export class AgentEventError extends Error {
  constructor(message) {
    super(message);
    this.name = "AgentEventError";
  }
}

/**
 * Validates and normalizes one event before it is persisted. Executors are
 * ordinary adapters — some of them will be third-party one day — so an
 * unknown kind or an oversized payload fails closed here rather than
 * reaching the event log and every subscribed client.
 */
export function normalizeAgentEvent({ kind, data = {}, occurredAt }) {
  if (!AGENT_EVENT_KINDS.includes(kind)) {
    throw new AgentEventError(`Unknown agent event kind: ${String(kind)}.`);
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw new AgentEventError(`Event data for ${kind} must be an object.`);
  }
  let encoded;
  try {
    encoded = JSON.stringify(data);
  } catch {
    throw new AgentEventError(`Event data for ${kind} is not serializable.`);
  }
  if (encoded === undefined) throw new AgentEventError(`Event data for ${kind} is not serializable.`);
  if (Buffer.byteLength(encoded, "utf8") > MAX_EVENT_BYTES) {
    throw new AgentEventError(`Event data for ${kind} exceeds ${MAX_EVENT_BYTES} bytes.`);
  }
  return {
    schemaVersion: AGENT_EVENT_SCHEMA_VERSION,
    kind,
    occurredAt: occurredAt ?? new Date().toISOString(),
    data: JSON.parse(encoded),
  };
}

/**
 * Progress text, shown separately from the assistant's answer. Never carries
 * private reasoning: executors summarize, they do not forward raw thinking.
 */
export function statusEvent(summary, extra = {}) {
  return { kind: "status", data: { summary: String(summary).slice(0, 2000), ...extra } };
}

export function assistantMessageEvent({ text, final = false, turnId = null }) {
  return { kind: "assistant_message", data: { text: String(text), final, turnId } };
}

export function toolProposalEvent({ toolCallId, tool, capability, risk, argumentsDigest, summary }) {
  return {
    kind: "tool_proposal",
    data: { toolCallId, tool, capability, risk, argumentsDigest, summary: String(summary ?? "").slice(0, 2000) },
  };
}

export function toolExecutionEvent({ toolCallId, tool, outcome, durationMs, summary, errorCode = null }) {
  return {
    kind: "tool_execution",
    data: { toolCallId, tool, outcome, durationMs, summary: String(summary ?? "").slice(0, 4000), errorCode },
  };
}

export function validationResultEvent({ profileId, outcome, summary, failures = [] }) {
  return {
    kind: "validation_result",
    data: { profileId, outcome, summary: String(summary ?? "").slice(0, 4000), failures: failures.slice(0, 50) },
  };
}

export function approvalRequestEvent({ approvalId, capability, summary, actionDigest }) {
  return { kind: "approval_request", data: { approvalId, capability, summary, actionDigest } };
}

/**
 * A durable receipt pointer. Artifacts stay on the operator's disk by
 * default; this records where, never the contents.
 */
export function artifactEvent({ name, path, bytes = null, digest = null }) {
  return { kind: "artifact", data: { name, path, bytes, digest } };
}

export function errorEvent({ code, summary, recoverable = true }) {
  return { kind: "error", data: { code, summary: String(summary).slice(0, 2000), recoverable } };
}

export function completionEvent({ status, summary, usage = null }) {
  return { kind: "completion", data: { status, summary: String(summary ?? "").slice(0, 4000), usage } };
}
