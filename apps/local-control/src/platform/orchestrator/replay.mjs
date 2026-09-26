import { BUDGET_DIMENSIONS, canTransition, digest } from "../../../../../packages/atlas-contracts/src/index.mjs";

import { redactSecrets } from "../memory/redaction.mjs";

/**
 * Execution replay (blueprint §12, Phase 7 P7-2).
 *
 * `replayExecution(store, tenantId, taskId)` rebuilds a task's ordered
 * timeline from the append-only event log and cross-checks it against the
 * mutable tables (tasks, task_transitions, tool_calls, approvals, artifacts,
 * policy_decisions). The event log is the witness: the triggers on `events`
 * make it append-only, so when a mutable row disagrees with it, the row is
 * what changed. Every disagreement becomes an issue in the report and
 * `consistent` is false.
 *
 * Checks:
 *  - transitions: the chain starts at `proposed`, each move is legal, each
 *    `from` equals the previous `to`, versions increase by one, the chain
 *    matches the task_transitions table and ends at the task's current status;
 *  - tool calls: every `completed` has an earlier `requested` and — unless it
 *    failed input validation — an earlier `decided`; the stored policy
 *    decision exists with the same effect; the tool_calls row's status
 *    matches the last completion;
 *  - approvals: every resolution has an earlier request; rows match events;
 *  - artifacts: content still hashes to its digest, and digest/verification
 *    match the events that recorded them;
 *  - usage: the sum of `budget.charged` amounts equals the task's usage;
 *  - completion: a completed task should have a verified artifact.
 *
 * Output is redacted: secret-shaped strings and secret-named keys are masked.
 */
const SCAN_PAGE = 1_000;
const SECRET_KEY = /^(password|passwd|secret|client_?secret|api_?key|apikey|authorization|cookie|set_?cookie|credentials?|private_?key|access_?token|refresh_?token|session_?token|token|bearer)$/iu;

export function redactValue(value) {
  if (typeof value === "string") return redactSecrets(value).text;
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, SECRET_KEY.test(key.replaceAll("-", "_")) ? "[REDACTED]" : redactValue(child)]));
  }
  return value;
}

function allEvents(store, tenantId, taskId) {
  const events = [];
  let afterSeq = 0;
  for (;;) {
    const page = store.listEvents(tenantId, { taskId, afterSeq, limit: SCAN_PAGE });
    events.push(...page);
    if (page.length < SCAN_PAGE) return events;
    afterSeq = page.at(-1).seq;
  }
}

function summarize(event) {
  const p = event.payload ?? {};
  switch (event.type) {
    case "task.created": return `task created: ${p.objective ?? ""}`.slice(0, 200);
    case "task.transitioned": return `${p.from} -> ${p.to}${p.reason ? ` (${p.reason})` : ""}`;
    case "tool_call.requested": return `requested ${p.tool}${p.resumed ? " (resumed after approval)" : ""}`;
    case "tool_call.decided": return `policy ${p.effect} for ${p.tool}`;
    case "tool_call.completed": return `tool call ${p.status}${p.error?.code ? ` (${p.error.code})` : ""}`;
    case "approval.requested": return `approval requested for ${p.tool}`;
    case "approval.resolved": return `approval ${p.decision}`;
    case "budget.charged": return `charged ${JSON.stringify(p.amounts ?? {})}`;
    case "budget.exceeded": return "budget exceeded";
    case "artifact.submitted": return `artifact ${p.kind} submitted`;
    case "artifact.verified": return `artifact ${p.verification}`;
    case "agent.message": return `message ${p.messageType ?? ""}`.trim();
    default: return event.type;
  }
}

export function replayExecution(store, tenantId, taskId) {
  const task = store.getTask(tenantId, taskId);
  if (!task) return { taskId, tenantId, found: false, consistent: false, issues: [{ code: "TASK_NOT_FOUND", message: "No such task in this tenant." }] };

  const events = allEvents(store, tenantId, taskId);
  const issues = [];
  const issue = (code, message, extra = {}) => issues.push({ code, message, ...extra });

  const timeline = events.map((event) => ({
    seq: event.seq, at: event.createdAt, type: event.type, summary: redactSecrets(summarize(event)).text, payload: redactValue(event.payload),
  }));

  // ---------------------------------------------------------------- transitions
  if (events[0]?.type !== "task.created") issue("MISSING_CREATION", "The event log does not start with task.created.");
  const transitionEvents = events.filter((e) => e.type === "task.transitioned");
  let status = "proposed";
  let version = 1;
  for (const event of transitionEvents) {
    const { from, to, version: v } = event.payload;
    if (from !== status) issue("TRANSITION_GAP", `Transition at seq ${event.seq} starts from '${from}' but the task was '${status}'.`, { seq: event.seq });
    if (!canTransition(from, to)) issue("ILLEGAL_TRANSITION", `Transition '${from}' -> '${to}' at seq ${event.seq} is not allowed.`, { seq: event.seq });
    if (v !== version + 1) issue("VERSION_GAP", `Transition at seq ${event.seq} has version ${v}, expected ${version + 1}.`, { seq: event.seq });
    status = to;
    version = v;
  }
  if (status !== task.status) issue("STATUS_MISMATCH", `The event log ends at '${status}' but the task row says '${task.status}'.`);
  const transitionRows = store.listTransitions(tenantId, taskId);
  const rowChain = transitionRows.map((row) => `${row.from}>${row.to}@${row.version}`).join(",");
  const eventChain = transitionEvents.map((e) => `${e.payload.from}>${e.payload.to}@${e.payload.version}`).join(",");
  if (rowChain !== eventChain) issue("TRANSITION_LOG_MISMATCH", "The task_transitions table disagrees with the event log.");

  // ---------------------------------------------------------------- tool calls
  const rows = new Map(store.getToolCalls(tenantId, taskId).map((call) => [call.id, call]));
  const calls = new Map();
  const callFor = (id) => {
    if (!calls.has(id)) calls.set(id, { toolCallId: id, tool: null, requested: [], decided: [], completed: [], approvalIds: [] });
    return calls.get(id);
  };
  for (const event of events) {
    const p = event.payload;
    if (!p?.toolCallId || !event.type.startsWith("tool_call.")) continue;
    const call = callFor(p.toolCallId);
    call.tool = call.tool ?? p.tool ?? null;
    if (event.type === "tool_call.requested") { call.requested.push(event.seq); if (p.approvalId) call.approvalIds.push(p.approvalId); }
    if (event.type === "tool_call.decided") call.decided.push({ seq: event.seq, effect: p.effect, decisionId: p.decisionId, reasons: p.reasons, policyVersion: p.policyVersion });
    if (event.type === "tool_call.completed") call.completed.push({ seq: event.seq, status: p.status, error: p.error ?? null, durationMs: p.durationMs ?? null });
  }
  for (const call of calls.values()) {
    for (const done of call.completed) {
      if (!call.requested.some((seq) => seq < done.seq)) issue("COMPLETED_WITHOUT_REQUEST", `Tool call ${call.toolCallId} completed without a prior request.`, { toolCallId: call.toolCallId, seq: done.seq });
      const inputRejected = done.error?.code === "INVALID_INPUT";
      if (!inputRejected && !call.decided.some((d) => d.seq < done.seq)) issue("COMPLETED_WITHOUT_DECISION", `Tool call ${call.toolCallId} completed without a policy decision.`, { toolCallId: call.toolCallId, seq: done.seq });
    }
    for (const decided of call.decided) {
      const record = decided.decisionId ? store.getPolicyDecision(tenantId, decided.decisionId) : null;
      if (!record) issue("DECISION_MISSING", `Policy decision ${decided.decisionId} for ${call.toolCallId} is not stored.`, { toolCallId: call.toolCallId });
      else if (record.effect !== decided.effect) issue("DECISION_MISMATCH", `Stored decision ${record.id} says '${record.effect}', the log says '${decided.effect}'.`, { toolCallId: call.toolCallId });
    }
    const row = rows.get(call.toolCallId);
    if (!row) issue("TOOL_CALL_ROW_MISSING", `Tool call ${call.toolCallId} appears in the log but not in tool_calls.`, { toolCallId: call.toolCallId });
    else if (call.completed.length > 0 && row.status !== call.completed.at(-1).status) {
      issue("TOOL_CALL_STATUS_MISMATCH", `Tool call ${call.toolCallId} row says '${row.status}', the log says '${call.completed.at(-1).status}'.`, { toolCallId: call.toolCallId });
    }
  }
  for (const row of rows.values()) {
    if (!calls.has(row.id)) issue("TOOL_CALL_UNLOGGED", `Tool call ${row.id} exists without any events.`, { toolCallId: row.id });
    else if (["succeeded", "failed", "denied"].includes(row.status) && calls.get(row.id).completed.length === 0) {
      issue("TOOL_CALL_UNLOGGED_COMPLETION", `Tool call ${row.id} is '${row.status}' but no completion was logged.`, { toolCallId: row.id });
    }
  }

  // ---------------------------------------------------------------- approvals
  const approvals = store.listApprovals(tenantId, { taskId });
  const approvalEvents = new Map();
  for (const event of events) {
    if (!event.type.startsWith("approval.")) continue;
    const id = event.payload.approvalId;
    if (!approvalEvents.has(id)) approvalEvents.set(id, { requested: null, resolved: null });
    approvalEvents.get(id)[event.type === "approval.requested" ? "requested" : "resolved"] = event;
  }
  for (const [id, seen] of approvalEvents) {
    if (seen.resolved && (!seen.requested || seen.requested.seq > seen.resolved.seq)) issue("RESOLVED_WITHOUT_REQUEST", `Approval ${id} was resolved without a prior request.`, { approvalId: id });
    const row = approvals.find((a) => a.id === id);
    if (!row) { issue("APPROVAL_ROW_MISSING", `Approval ${id} is in the log but not stored.`, { approvalId: id }); continue; }
    if (seen.resolved && row.status !== seen.resolved.payload.decision) issue("APPROVAL_MISMATCH", `Approval ${id} row says '${row.status}', the log says '${seen.resolved.payload.decision}'.`, { approvalId: id });
    if (!seen.resolved && ["approved", "rejected"].includes(row.status)) issue("APPROVAL_UNLOGGED_RESOLUTION", `Approval ${id} is '${row.status}' without a logged resolution.`, { approvalId: id });
  }
  for (const call of calls.values()) {
    for (const approvalId of call.approvalIds) {
      const row = approvals.find((a) => a.id === approvalId);
      const decision = call.decided.find((d) => d.effect === "allow");
      if (decision && row?.status !== "approved") issue("APPROVAL_NOT_GRANTED", `Tool call ${call.toolCallId} was allowed on approval ${approvalId}, which is '${row?.status ?? "missing"}'.`, { toolCallId: call.toolCallId });
    }
  }

  // ---------------------------------------------------------------- artifacts
  const artifacts = store.listArtifacts(tenantId, { taskId });
  for (const artifact of artifacts) {
    if (digest(artifact.content) !== artifact.contentDigest) issue("ARTIFACT_TAMPERED", `Artifact ${artifact.id} content no longer matches its digest.`, { artifactId: artifact.id });
    const submitted = events.find((e) => e.type === "artifact.submitted" && e.payload.artifactId === artifact.id);
    if (!submitted) issue("ARTIFACT_UNLOGGED", `Artifact ${artifact.id} has no submission event.`, { artifactId: artifact.id });
    else if (submitted.payload.contentDigest !== artifact.contentDigest) issue("ARTIFACT_DIGEST_MISMATCH", `Artifact ${artifact.id} digest differs from the one logged at submission.`, { artifactId: artifact.id });
    const verified = events.find((e) => e.type === "artifact.verified" && e.payload.artifactId === artifact.id);
    if (artifact.verification !== "unverified" && (!verified || verified.payload.verification !== artifact.verification)) {
      issue("ARTIFACT_VERIFICATION_MISMATCH", `Artifact ${artifact.id} is '${artifact.verification}' but the log says '${verified?.payload.verification ?? "nothing"}'.`, { artifactId: artifact.id });
    }
  }
  if (task.status === "completed" && !artifacts.some((a) => a.verification === "verified")) {
    issue("COMPLETED_WITHOUT_EVIDENCE", "The task is completed but no verified artifact backs it.", { severity: "warning" });
  }

  // ---------------------------------------------------------------- usage and cost
  const recomputed = Object.fromEntries(BUDGET_DIMENSIONS.map((d) => [d, 0]));
  for (const event of events) {
    if (event.type !== "budget.charged") continue;
    for (const [d, v] of Object.entries(event.payload.amounts ?? {})) if (d in recomputed && Number.isInteger(v)) recomputed[d] += v;
  }
  const recorded = Object.fromEntries(BUDGET_DIMENSIONS.map((d) => [d, task.usage?.[d] ?? 0]));
  const usageDiff = BUDGET_DIMENSIONS.filter((d) => recomputed[d] !== recorded[d]);
  if (usageDiff.length > 0) issue("USAGE_MISMATCH", `Recorded usage differs from the charged events on ${usageDiff.join(", ")}.`, { recomputed, recorded });

  const errors = issues.filter((i) => i.severity !== "warning");
  return {
    taskId,
    tenantId,
    found: true,
    correlationId: task.correlationId,
    status: task.status,
    consistent: errors.length === 0,
    issues,
    eventCount: events.length,
    timeline,
    transitions: transitionEvents.map((e) => ({ seq: e.seq, at: e.createdAt, from: e.payload.from, to: e.payload.to, reason: redactValue(e.payload.reason ?? null), actor: e.payload.actor ?? null })),
    toolCalls: [...calls.values()].map((call) => ({
      toolCallId: call.toolCallId,
      tool: call.tool ?? rows.get(call.toolCallId)?.tool ?? null,
      status: rows.get(call.toolCallId)?.status ?? null,
      input: redactValue(rows.get(call.toolCallId)?.input ?? null),
      output: redactValue(rows.get(call.toolCallId)?.output ?? null),
      decisions: call.decided.map((d) => ({ effect: d.effect, decisionId: d.decisionId, policyVersion: d.policyVersion, reasons: redactValue(d.reasons) })),
      completions: call.completed.map((c) => ({ status: c.status, error: redactValue(c.error), durationMs: c.durationMs })),
      approvalIds: call.approvalIds,
    })),
    approvals: approvals.map((a) => ({ id: a.id, tool: a.tool, status: a.status, resolvedBy: a.resolvedBy, toolCallId: a.toolCallId, consumedBy: a.consumedBy })),
    artifacts: artifacts.map((a) => ({ id: a.id, kind: a.kind, verification: a.verification, contentDigest: a.contentDigest, evidenceCount: a.verificationEvidence.length })),
    usage: { recomputed, recorded, budget: task.budget },
    cost: {
      costMicroUsd: recomputed.costMicroUsd,
      inputTokens: recomputed.inputTokens,
      outputTokens: recomputed.outputTokens,
      toolCalls: recomputed.toolCalls,
      wallTimeMs: recomputed.wallTimeMs,
    },
  };
}
