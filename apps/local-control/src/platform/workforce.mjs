import { digest, validateSchema } from "../../../../packages/atlas-contracts/src/index.mjs";
import { TaskDelegation } from "./family/delegation.mjs";
import { verifyArtifact } from "./executor.mjs";
import { redactSecrets } from "./memory/redaction.mjs";

const TERMINAL = new Set(["completed", "failed", "cancelled"]);

/** A bounded, durable bridge between agent ownership and platform execution.
 * Plans are explicit tool assignments; models do not grant permissions or
 * declare their own work verified. A separate reviewer checks stored outputs.
 */
export class WorkforceCoordinator {
  #store; #registry; #memory; #router; #executor; #delegation;
  #active = new Map();
  #runs = new Map();

  constructor({ store, registry, memory, router, executor }) {
    this.#store = store;
    this.#registry = registry;
    this.#memory = memory;
    this.#router = router;
    this.#executor = executor;
    this.#delegation = new TaskDelegation(registry);
    registry.db.exec(`CREATE TABLE IF NOT EXISTS workforce_runs (
      tenant_id TEXT NOT NULL, task_id TEXT NOT NULL, snapshot TEXT NOT NULL,
      PRIMARY KEY (tenant_id, task_id))`);
  }

  get(tenantId, taskId) {
    const row = this.#registry.db.prepare("SELECT snapshot FROM workforce_runs WHERE tenant_id=? AND task_id=?").get(tenantId, taskId);
    return row ? JSON.parse(row.snapshot) : null;
  }

  /** Bounded summaries for supervision; plans and model prompts stay in detail reads. */
  list(tenantId, { limit = 50 } = {}) {
    const count = Number.isSafeInteger(limit) ? Math.min(100, Math.max(1, limit)) : 50;
    return this.#registry.db.prepare("SELECT snapshot FROM workforce_runs WHERE tenant_id=? ORDER BY rowid DESC LIMIT ?")
      .all(tenantId, count).map(row => {
        const run = JSON.parse(row.snapshot);
        const steps = Array.isArray(run.steps) ? run.steps : [];
        return { taskId: run.taskId, objective: String(run.objective ?? "").slice(0, 500), status: run.status,
          stepCount: steps.length, completedSteps: steps.filter(step => step.memoryIds?.length > 0).length,
          artifactCount: steps.reduce((sum, step) => sum + (step.artifacts?.length ?? 0), 0) };
      });
  }

  #save(run) {
    this.#registry.db.prepare("INSERT INTO workforce_runs VALUES (?,?,?) ON CONFLICT(tenant_id,task_id) DO UPDATE SET snapshot=excluded.snapshot")
      .run(run.tenantId, run.taskId, JSON.stringify(run));
  }

  create({ tenantId, userId, ownerAgentId, reviewerAgentId, objective, steps, budget, constraints = {} }) {
    const owner = this.#registry.requireAgent(tenantId, ownerAgentId);
    const reviewer = this.#registry.requireAgent(tenantId, reviewerAgentId);
    if (!this.#registry.isLive(owner) || !this.#registry.isLive(reviewer) || !owner.persistent || !reviewer.persistent) throw new Error("Agents must be active and persistent.");
    if (!Array.isArray(steps) || steps.length < 1 || steps.length > 8) throw new Error("A workforce plan needs 1–8 steps.");
    if (!this.#registry.isDescendant(tenantId, reviewerAgentId, ownerAgentId)) throw new Error("Reviewer must belong to the owner's workforce.");
    const plan = steps.map((step) => {
      const agent = this.#registry.requireAgent(tenantId, step.agentId);
      if (!this.#registry.isLive(agent) || !agent.persistent || agent.id === reviewer.id || !this.#registry.isDescendant(tenantId, agent.id, owner.id)) throw new Error("Each worker must be a persistent descendant distinct from the reviewer.");
      if (!Array.isArray(step.calls) || step.calls.length < 1 || step.calls.length > 16) throw new Error("Each step needs 1–16 tool calls.");
      for (const call of step.calls) {
        if (!this.#executor.has(call.tool) || !call.input || typeof call.input !== "object" || Array.isArray(call.input)) throw new Error("Unknown tool or invalid input.");
        if (!call.outputSchema || typeof call.outputSchema !== "object" || Array.isArray(call.outputSchema) || Object.keys(call.outputSchema).length === 0) throw new Error("Every tool call needs an explicit output schema for quality review.");
      }
      return structuredClone(step);
    });
    if (!budget || !Number.isInteger(budget.toolCalls) || budget.toolCalls < 1 || !Number.isInteger(budget.wallTimeMs) || budget.wallTimeMs < 1) throw new Error("Explicit tool-call and time budgets are required.");
    const childBudget = Object.fromEntries(Object.entries(budget).map(([key, value]) => [key, Math.floor(value / plan.length)]));
    if (plan.some((step) => step.calls.length > childBudget.toolCalls)) throw new Error("Tool-call budget cannot cover the planned assignments.");
    // Route selection applies privacy/cost/provider constraints before intake.
    const route = this.#router.route({ task: { complexity: "moderate" }, constraints });
    for (const step of plan) for (const call of step.calls) {
      if (call.tool === "model.respond") call.input = { ...call.input, prompt: redactSecrets(call.input.prompt).text, modelProfile: route.model };
    }
    const reserved = new Set([ownerAgentId, reviewerAgentId, ...plan.map((s) => s.agentId)]);
    for (const row of this.#registry.db.prepare("SELECT snapshot FROM workforce_runs WHERE tenant_id=?").all(tenantId)) {
      const existing = JSON.parse(row.snapshot);
      if ((!TERMINAL.has(existing.status) || this.#active.has(`${tenantId}:${existing.taskId}`)) && [existing.ownerAgentId, existing.reviewerAgentId, ...existing.steps.map((s) => s.agentId)].some((id) => reserved.has(id))) throw new Error("An agent already owns an unfinished workforce run.");
    }
    const task = this.#store.createTask({ tenantId, userId, agentId: owner.id, objective,
      successCriteria: ["All delegated outputs pass independent schema and evidence checks."], budget });
    const run = { tenantId, userId, taskId: task.id, ownerAgentId, reviewerAgentId, objective,
      status: "queued", route, budget, childBudget, steps: plan.map((step) => ({ ...step, taskId: null, artifacts: [], memoryIds: [] })), reviewTaskId: null };
    this.#save(run);
    this.#initialize(run);
    return this.get(tenantId, task.id);
  }

  #initialize(run) {
    const { tenantId, taskId, ownerAgentId } = run;
    const task = this.#store.getTask(tenantId, taskId);
    if (!this.#delegation.getAssignment(tenantId, taskId)) this.#delegation.assignTask({ tenantId, taskId, agentId: ownerAgentId, correlationId: task.correlationId, payload: { objective: run.objective } });
    if (task.status === "proposed") this.#store.transitionTask(tenantId, taskId, "authorized", { actor: run.userId });
    if (this.#store.getTask(tenantId, taskId).status === "authorized") this.#store.transitionTask(tenantId, taskId, "queued", { actor: run.userId });
  }

  /** Restart never launches work. Explicit resume reconciles durable stages. */
  recover(tenantId) {
    const rows = this.#registry.db.prepare("SELECT snapshot FROM workforce_runs WHERE tenant_id=?").all(tenantId);
    const recovered = [];
    for (const row of rows) {
      const run = JSON.parse(row.snapshot);
      if (TERMINAL.has(run.status)) continue;
      run.status = "interrupted";
      this.#save(run);
      recovered.push(run);
    }
    return recovered;
  }

  resume(tenantId, taskId) {
    const key = `${tenantId}:${taskId}`;
    if (this.#active.has(key)) return this.#active.get(key);
    const run = this.get(tenantId, taskId);
    if (!run) throw new Error("Workforce run not found.");
    if (TERMINAL.has(run.status)) return Promise.resolve(run);
    this.#runs.set(key, run);
    const operation = this.#execute(run).finally(() => { this.#active.delete(key); this.#runs.delete(key); });
    this.#active.set(key, operation);
    return operation;
  }

  cancel(tenantId, taskId) {
    const run = this.#runs.get(`${tenantId}:${taskId}`) ?? this.get(tenantId, taskId);
    if (!run) throw new Error("Workforce run not found.");
    if (TERMINAL.has(run.status)) return run;
    run.status = "cancelled";
    this.#save(run);
    for (const id of [taskId, run.reviewTaskId, ...run.steps.map((s) => s.taskId)].filter(Boolean)) {
      const task = this.#store.getTask(tenantId, id);
      if (!TERMINAL.has(task.status)) this.#store.transitionTask(tenantId, id, "cancelled", { actor: run.userId });
    }
    this.#delegation.cancelTask(tenantId, taskId, { reason: "Cancelled by the local owner." });
    return run;
  }

  async #execute(run) {
    const { tenantId, taskId, ownerAgentId, reviewerAgentId } = run;
    this.#initialize(run);
    run.status = "running";
    this.#save(run);
    const parent = this.#store.getTask(tenantId, taskId);
    if (parent.status === "completed") {
      if (!this.#delegation.getAssignment(tenantId, taskId).verified) this.#delegation.submitResult({ tenantId, taskId, agentId: ownerAgentId, result: parent.result, verified: true });
      run.status = "completed";
      this.#save(run);
      return run;
    }
    if (parent.status === "queued") this.#store.transitionTask(tenantId, taskId, "running", { actor: ownerAgentId });
    try {
      for (const step of run.steps) {
        if (run.status === "cancelled") throw new Error("Workforce cancelled.");
        const child = this.#child(run, step, step.agentId, step.objective || run.objective);
        if (child.status === "completed") continue;
        const agent = this.#registry.requireAgent(tenantId, step.agentId);
        this.#registry.markRunning(tenantId, agent.id);
        for (let index = 0; index < step.calls.length; index++) {
          if (step.artifacts[index]) continue;
          const call = step.calls[index];
          // Reserve an agent's durable lifetime allowance only once, even
          // when a restart replays an already-successful executor record.
          step.chargedCalls ??= [];
          if (!step.chargedCalls.includes(index)) this.#registry.transaction(() => {
            this.#registry.chargeBudget(tenantId, agent.id, { toolCalls: 1 });
            step.chargedCalls.push(index);
            this.#save(run);
          });
          if (call.tool === "model.respond") {
            const remaining = this.#store.getTask(tenantId, child.id);
            const inputBound = Buffer.byteLength(call.input.prompt ?? "", "utf8") + 512;
            const outputBound = call.input.maxOutputTokens ?? 256;
            if (remaining.budget.inputTokens === undefined || remaining.budget.outputTokens === undefined ||
              inputBound > remaining.budget.inputTokens - remaining.usage.inputTokens ||
              outputBound > remaining.budget.outputTokens - remaining.usage.outputTokens) throw new Error("Model work requires sufficient explicit input and output token budgets.");
          }
          const outcome = await this.#executor.invoke({ tenantId, userId: run.userId, agentId: agent.id,
            taskId: child.id, tool: call.tool, input: call.input, grantedPermissions: agent.permissions });
          if (run.status === "cancelled") throw new Error("Workforce cancelled.");
          if (outcome.status !== "succeeded") throw new Error(`Workforce tool stopped: ${outcome.status}.`);
          const charged = this.#store.getTask(tenantId, child.id);
          if (Object.entries(charged.budget).some(([dimension, limit]) => charged.usage[dimension] > limit)) throw new Error("Workforce execution exceeded its budget; completion is blocked.");
          const artifact = this.#store.submitArtifact({ tenantId, taskId: child.id, toolCallId: outcome.toolCallId,
            kind: "workforce_output", content: { output: outcome.result.output, evidence: outcome.result.evidence ?? [], modelRoute: run.route.model } });
          step.artifacts[index] = artifact.id;
          this.#save(run);
        }
        if (this.#store.getTask(tenantId, child.id).status === "running") this.#store.transitionTask(tenantId, child.id, "verifying", { actor: agent.id });
        if (!this.#delegation.getAssignment(tenantId, child.id).verified) this.#delegation.submitResult({ tenantId, taskId: child.id, agentId: agent.id, result: { artifacts: step.artifacts } });
        this.#registry.completeAgentWork(tenantId, agent.id);
      }
      if (this.#store.getTask(tenantId, taskId).status === "running") this.#store.transitionTask(tenantId, taskId, "verifying", { actor: ownerAgentId });
      const reviewStep = { taskId: run.reviewTaskId, review: true };
      const review = this.#child(run, reviewStep, reviewerAgentId, "Independently verify delegated output schemas and tool evidence.");
      run.reviewTaskId = review.id;
      this.#save(run);
      this.#registry.markRunning(tenantId, reviewerAgentId);
      for (const step of run.steps) {
        for (let index = 0; index < step.artifacts.length; index++) {
          let artifact = this.#store.getArtifact(tenantId, step.artifacts[index]);
          if (artifact.verification === "unverified") artifact = await verifyArtifact(this.#store, { tenantId, artifactId: artifact.id,
            check: (a) => {
              const errors = validateSchema(step.calls[index].outputSchema, a.content.output);
              const call = this.#store.getToolCall(tenantId, a.toolCallId);
              const ok = errors.length === 0 && call?.status === "succeeded" && call.agentId === step.agentId &&
                digest(call.output) === digest(a.content.output) && a.content.evidence.length > 0;
              return { ok, evidence: [{ check: "output_schema_and_tool_record", ok, errors, reviewerAgentId, toolCallId: a.toolCallId }] };
            } });
          if (run.status === "cancelled") throw new Error("Workforce cancelled.");
          if (artifact.verification !== "verified") {
            run.status = "failed";
            this.#store.transitionTask(tenantId, step.taskId, "failed", { actor: reviewerAgentId });
            this.#store.transitionTask(tenantId, review.id, "failed", { actor: reviewerAgentId });
            this.#store.transitionTask(tenantId, taskId, "failed", { actor: reviewerAgentId });
            this.#delegation.cancelTask(tenantId, taskId, { reason: "Independent quality review rejected an output." });
            throw new Error("Independent quality review rejected an output.");
          }
          if (!step.memoryIds[index]) {
            const memory = this.#memory.write({ tenantId, owner: step.agentId, scope: "project", scopeRef: taskId,
              content: JSON.stringify(artifact.content.output), provenance: { source: "workforce", sourceRefs: [artifact.id], producedBy: step.agentId } });
            // This verifies the stored output and its provenance, not every claim in model prose.
            step.memoryIds[index] = memory.id;
            this.#save(run);
          }
        }
        if (this.#store.getTask(tenantId, step.taskId).status === "verifying") this.#store.transitionTask(tenantId, step.taskId, "completed", { actor: reviewerAgentId, result: { artifacts: step.artifacts, reviewedBy: reviewerAgentId } });
        if (!this.#delegation.getAssignment(tenantId, step.taskId).verified) this.#delegation.submitResult({ tenantId, taskId: step.taskId, agentId: step.agentId, result: { artifacts: step.artifacts, reviewedBy: reviewerAgentId }, verified: true });
      }
      if (this.#store.getTask(tenantId, review.id).status === "running") this.#store.transitionTask(tenantId, review.id, "verifying", { actor: reviewerAgentId });
      if (this.#store.getTask(tenantId, review.id).status === "verifying") this.#store.transitionTask(tenantId, review.id, "completed", { actor: reviewerAgentId });
      if (!this.#delegation.getAssignment(tenantId, review.id).verified) this.#delegation.submitResult({ tenantId, taskId: review.id, agentId: reviewerAgentId, result: { checkedArtifacts: run.steps.flatMap((s) => s.artifacts) }, verified: true });
      const result = this.#delegation.mergeResults(tenantId, taskId);
      if (this.#store.getTask(tenantId, taskId).status === "verifying") this.#store.transitionTask(tenantId, taskId, "completed", { actor: reviewerAgentId, result });
      if (!this.#delegation.getAssignment(tenantId, taskId).verified) this.#delegation.submitResult({ tenantId, taskId, agentId: ownerAgentId, result, verified: true });
      run.status = "completed";
    } catch (error) {
      // Durable executor records prevent an uncertain in-flight action from
      // being blindly repeated. An operator can inspect it before resuming.
      if (!TERMINAL.has(run.status)) run.status = "interrupted";
      run.error = String(error.message).slice(0, 500);
    } finally {
      for (const id of new Set([reviewerAgentId, ...run.steps.map((s) => s.agentId)])) {
        const agent = this.#registry.getAgent(tenantId, id);
        if (agent?.state === "running") this.#registry.completeAgentWork(tenantId, id);
      }
      this.#save(run);
    }
    return this.get(tenantId, taskId);
  }

  #child(run, step, agentId, objective) {
    if (!step.taskId) {
      const child = this.#store.createTask({ tenantId: run.tenantId, userId: run.userId, agentId,
        objective, successCriteria: ["Independent output checks pass."], budget: step.review ? { toolCalls: 0, wallTimeMs: run.budget.wallTimeMs } : run.childBudget,
        parentTaskId: run.taskId, correlationId: this.#store.getTask(run.tenantId, run.taskId).correlationId });
      step.taskId = child.id;
      if (step.review) run.reviewTaskId = child.id;
      this.#save(run);
    }
    if (!this.#delegation.getAssignment(run.tenantId, step.taskId)) this.#delegation.delegateTask({ tenantId: run.tenantId,
      fromAgentId: run.ownerAgentId, toAgentId: agentId, taskId: step.taskId, parentTaskId: run.taskId, payload: { objective } });
    for (const [from, to] of [["proposed", "authorized"], ["authorized", "queued"], ["queued", "running"]]) {
      if (this.#store.getTask(run.tenantId, step.taskId).status === from) this.#store.transitionTask(run.tenantId, step.taskId, to, { actor: agentId });
    }
    return this.#store.getTask(run.tenantId, step.taskId);
  }
}
