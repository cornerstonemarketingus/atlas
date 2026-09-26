/**
 * Per-task observability rollup (blueprint §13 P).
 *
 * Read-only view over a PlatformTaskStore: it never writes, and every read
 * is scoped by tenant. It answers "what did this task do and what did it
 * cost?":
 *
 *  - tool calls, by tool and by status, with durations;
 *  - models used, from `model` fields on events and tool-call outputs, with
 *    tokens and cost when a budget charge names its model;
 *  - cost, computed as the sum of `costMicroUsd` over every `budget.charged`
 *    event (the same events TaskBudget writes), cross-checked against the
 *    task's persisted usage snapshot;
 *  - memory references (memory.* tool calls and `memoryRefs` on payloads);
 *  - failures (failed/denied tool calls, budget overruns, rejected or
 *    expired approvals, rejected artifacts, a failed task);
 *  - artifacts with their verification state.
 */

const PAGE = 500;

export class ObservabilityError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ObservabilityError";
    this.code = code;
  }
}

/** Every event for one task, following `seq` past the store's page size. */
export function allTaskEvents(store, tenantId, taskId) {
  const events = [];
  let afterSeq = 0;
  for (;;) {
    const page = store.listEvents(tenantId, { taskId, afterSeq, limit: PAGE });
    events.push(...page);
    if (page.length < PAGE) return events;
    afterSeq = page.at(-1).seq;
  }
}

export function taskObservability(store, tenantId, taskId) {
  const task = store.getTask(tenantId, taskId);
  if (!task) throw new ObservabilityError("NOT_FOUND", "No such task in this tenant.");
  const events = allTaskEvents(store, tenantId, taskId);
  const calls = store.getToolCalls(tenantId, taskId);
  const artifacts = store.listArtifacts(tenantId, { taskId });

  // -- tool calls ----------------------------------------------------------
  const byStatus = {};
  const byTool = {};
  for (const call of calls) {
    byStatus[call.status] = (byStatus[call.status] ?? 0) + 1;
    const entry = byTool[call.tool] ??= { count: 0, succeeded: 0, failed: 0, denied: 0, totalDurationMs: 0 };
    entry.count += 1;
    if (call.status === "succeeded") entry.succeeded += 1;
    if (call.status === "failed") entry.failed += 1;
    if (call.status === "denied") entry.denied += 1;
    entry.totalDurationMs += call.durationMs ?? 0;
  }

  // -- cost ----------------------------------------------------------------
  const cost = { totalMicroUsd: 0, chargedEvents: 0, byPhase: {}, byModel: {}, unattributedMicroUsd: 0 };
  const tokens = { inputTokens: 0, outputTokens: 0 };
  const models = new Map();
  const touchModel = (name) => {
    if (!models.has(name)) models.set(name, { model: name, uses: 0, inputTokens: 0, outputTokens: 0, costMicroUsd: 0 });
    return models.get(name);
  };
  for (const event of events) {
    if (event.type !== "budget.charged") continue;
    const amounts = event.payload?.amounts ?? {};
    const micro = Number.isInteger(amounts.costMicroUsd) ? amounts.costMicroUsd : 0;
    cost.chargedEvents += 1;
    cost.totalMicroUsd += micro;
    const phase = event.payload?.phase ?? "unknown";
    cost.byPhase[phase] = (cost.byPhase[phase] ?? 0) + micro;
    tokens.inputTokens += amounts.inputTokens ?? 0;
    tokens.outputTokens += amounts.outputTokens ?? 0;
    const model = typeof event.payload?.model === "string" ? event.payload.model : null;
    if (model) {
      const entry = touchModel(model);
      entry.costMicroUsd += micro;
      entry.inputTokens += amounts.inputTokens ?? 0;
      entry.outputTokens += amounts.outputTokens ?? 0;
      cost.byModel[model] = (cost.byModel[model] ?? 0) + micro;
    } else {
      cost.unattributedMicroUsd += micro;
    }
  }
  const recorded = task.usage?.costMicroUsd ?? 0;
  cost.recordedUsageMicroUsd = recorded;
  cost.consistent = recorded === cost.totalMicroUsd;
  cost.limitMicroUsd = task.budget?.costMicroUsd ?? null;

  // -- models used (beyond cost attribution) --------------------------------
  for (const event of events) {
    const model = event.payload?.model;
    if (typeof model === "string" && model) touchModel(model).uses += 1;
  }
  for (const call of calls) {
    const model = call.output && typeof call.output === "object" ? (call.output.model ?? call.output.usage?.model) : null;
    if (typeof model === "string" && model) touchModel(model).uses += 1;
  }

  // -- memory references ------------------------------------------------------
  const memory = new Map();
  const addMemory = (ref, source) => {
    if (typeof ref !== "string" || !ref) return;
    const entry = memory.get(ref) ?? { ref, sources: [] };
    if (!entry.sources.includes(source)) entry.sources.push(source);
    memory.set(ref, entry);
  };
  for (const event of events) for (const ref of asArray(event.payload?.memoryRefs)) addMemory(ref, `event:${event.type}`);
  for (const call of calls) {
    for (const ref of asArray(call.output?.memoryRefs)) addMemory(ref, `tool:${call.tool}`);
    if (call.tool.startsWith("memory.")) {
      for (const ref of [call.input?.id, call.input?.memoryId, call.output?.id, ...asArray(call.output?.ids)]) addMemory(ref, `tool:${call.tool}`);
    }
  }

  // -- failures ---------------------------------------------------------------
  const failures = [];
  for (const call of calls) {
    if (call.status === "failed" || call.status === "denied") {
      failures.push({ kind: `tool_call.${call.status}`, toolCallId: call.id, tool: call.tool, code: call.error?.code ?? null, message: call.error?.message ?? null, at: call.completedAt ?? call.createdAt });
    }
  }
  for (const event of events) {
    if (event.type === "budget.exceeded") failures.push({ kind: "budget.exceeded", phase: event.payload?.phase ?? null, detail: event.payload?.over ?? event.payload?.dimension ?? null, at: event.createdAt });
    if (event.type === "approval.resolved" && event.payload?.decision !== "approved") failures.push({ kind: `approval.${event.payload?.decision}`, approvalId: event.payload?.approvalId, tool: event.payload?.tool ?? null, at: event.createdAt });
    if (event.type === "artifact.verified" && event.payload?.verification === "rejected") failures.push({ kind: "artifact.rejected", artifactId: event.payload?.artifactId, at: event.createdAt });
    if (event.type === "task.transitioned" && event.payload?.to === "failed") failures.push({ kind: "task.failed", reason: event.payload?.reason ?? null, at: event.createdAt });
  }
  failures.sort((a, b) => String(a.at).localeCompare(String(b.at)));

  const eventCounts = {};
  for (const event of events) eventCounts[event.type] = (eventCounts[event.type] ?? 0) + 1;

  return {
    task: { id: task.id, status: task.status, objective: task.objective, correlationId: task.correlationId, createdAt: task.createdAt, updatedAt: task.updatedAt },
    toolCalls: {
      total: calls.length,
      byStatus,
      byTool,
      calls: calls.map((c) => ({ id: c.id, tool: c.tool, status: c.status, durationMs: c.durationMs, agentId: c.agentId, error: c.error?.code ?? null })),
    },
    models: [...models.values()].sort((a, b) => b.costMicroUsd - a.costMicroUsd || a.model.localeCompare(b.model)),
    tokens,
    cost,
    memoryReferences: [...memory.values()],
    failures,
    artifacts: artifacts.map((a) => ({ id: a.id, kind: a.kind, verification: a.verification, contentDigest: a.contentDigest, toolCallId: a.toolCallId ?? null })),
    events: { total: events.length, byType: eventCounts, lastSeq: events.at(-1)?.seq ?? null },
  };
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}
