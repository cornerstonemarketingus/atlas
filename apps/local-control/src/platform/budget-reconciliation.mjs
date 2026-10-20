import { BUDGET_DIMENSIONS } from "../../../../packages/atlas-contracts/src/index.mjs";
const amounts = value => Object.fromEntries(BUDGET_DIMENSIONS.map(d => {
  const n = value?.[d] ?? 0;
  if (!Number.isSafeInteger(n) || n < 0) throw new Error("Budget reconciliation requires safe non-negative integer usage.");
  return [d, n];
}));
function add(target, increment) {
  for (const d of BUDGET_DIMENSIONS) {
    target[d] += increment[d] ?? 0;
    if (!Number.isSafeInteger(target[d])) throw new Error("Budget reconciliation usage exceeds the safe integer range.");
  }
}
/** Explicit, transactional rollout maintenance; never run on each tool call. */
export function reconcileTaskBudgets({ store, tenantId, apply = false }) {
  return store.transaction(() => {
    const tasks = store.listTasks(tenantId, { limit: 100001 });
    if (tasks.length > 100000) throw new Error("Budget reconciliation task limit exceeded; partition the rollout before proceeding.");
    const byId = new Map(tasks.map(task => [task.id, task]));
    const ancestors = new Map();
    for (const task of tasks) {
      const path = []; const seen = new Set([task.id]); let id = task.parentTaskId;
      while (id) {
        if (seen.has(id) || path.length >= 63) throw new Error("Budget reconciliation found an invalid parent chain.");
        const parent = byId.get(id);
        if (!parent) throw new Error("Budget reconciliation parent is missing from this tenant.");
        seen.add(id); path.push(id); id = parent.parentTaskId;
      }
      ancestors.set(task.id, path);
    }
    const credits = new Map(tasks.map(task => [task.id, new Map()]));
    let cursor = 0; let scanned = 0;
    for (;;) {
      const events = store.listEvents(tenantId, { afterSeq: cursor, limit: 1000 });
      if (!events.length) break;
      scanned += events.length;
      if (scanned > 1000000) throw new Error("Budget reconciliation event limit exceeded; partition the rollout before proceeding.");
      cursor = events.at(-1).seq;
      for (const event of events) {
        const source = event.payload?.sourceTaskId;
        if (event.type !== "budget.charged" || !source || source === event.taskId) continue;
        if (!byId.has(source) || !ancestors.get(source).includes(event.taskId)) throw new Error("Budget reconciliation found an invalid descendant credit.");
        const own = credits.get(event.taskId);
        if (!own.has(source)) own.set(source, amounts({}));
        add(own.get(source), amounts(event.payload.amounts));
        // A release returns part of an earlier reservation, so it reduces the credit.
        if (event.payload.phase === "release") {
          const released = amounts(event.payload.released); const credit = own.get(source);
          for (const d of BUDGET_DIMENSIONS) credit[d] -= released[d];
          if (Object.values(credit).some(n => n < 0)) throw new Error("Budget reconciliation found a release larger than its credit.");
        }
      }
    }
    const direct = new Map();
    for (const task of tasks) {
      const own = amounts(task.usage);
      for (const credited of credits.get(task.id).values()) for (const d of BUDGET_DIMENSIONS) own[d] -= credited[d];
      if (Object.values(own).some(n => n < 0)) throw new Error("Budget usage is below recorded descendant credits; manual reconciliation is required.");
      direct.set(task.id, own);
    }
    const updates = [];
    for (const task of tasks) for (const parentId of ancestors.get(task.id)) {
      const credited = credits.get(parentId).get(task.id) ?? amounts({});
      const delta = Object.fromEntries(BUDGET_DIMENSIONS.map(d => [d, direct.get(task.id)[d] - credited[d]]));
      if (Object.values(delta).some(n => n < 0)) throw new Error("Descendant credits exceed direct usage; manual reconciliation is required.");
      if (Object.values(delta).some(n => n > 0)) updates.push({ taskId: parentId, sourceTaskId: task.id, amounts: delta });
      if (updates.length > 100000) throw new Error("Budget reconciliation update limit exceeded; a larger rollout requires separate review.");
    }
    // Validate every resulting total before applying any update.
    const totals = new Map(tasks.map(task => [task.id, amounts(task.usage)]));
    for (const update of updates) add(totals.get(update.taskId), update.amounts);
    if (apply) {
      const running = new Map(tasks.map(task => [task.id, amounts(task.usage)]));
      for (const update of updates) {
        const task = byId.get(update.taskId); const usage = running.get(task.id); add(usage, update.amounts);
        store.recordUsage(tenantId, task.id, usage);
        store.appendEvent({ type: "budget.charged", tenantId, taskId: task.id, userId: task.userId, agentId: task.agentId,
          correlationId: task.correlationId, payload: { phase: "reconcile", sourceTaskId: update.sourceTaskId, amounts: update.amounts, usage: { ...usage } } });
        const over = BUDGET_DIMENSIONS.filter(d => task.budget[d] !== undefined && usage[d] > task.budget[d])
          .map(d => ({ dimension: d, attempted: usage[d], limit: task.budget[d] }));
        if (over.length) store.appendEvent({ type: "budget.exceeded", tenantId, taskId: task.id, userId: task.userId, agentId: task.agentId,
          correlationId: task.correlationId, payload: { phase: "reconcile", over, usage: { ...usage } } });
      }
    }
    return { applied: apply, taskCount: tasks.length, eventsScanned: scanned, updates };
  });
}
