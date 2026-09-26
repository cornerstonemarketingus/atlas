import { randomUUID } from "node:crypto";

import { planMission } from "./planner.mjs";
import { toolsForAgent } from "./permissions.mjs";

/**
 * Agent missions: a goal becomes a plan over the real organization, the plan
 * runs on the existing MissionScheduler (dependencies, concurrency, leases,
 * checkpoints, cancellation, restart recovery), each step is executed by the
 * agent it names, and the whole mission is one canonical platform task whose
 * status, tool calls, artifacts and events every surface reads.
 *
 * There is exactly one scheduler and one task lifecycle: this service only
 * composes them.
 */
const TENANT = "local";
const TERMINAL = new Set(["completed", "failed", "cancelled"]);
const STEP_BUDGET = { toolCalls: 40, elapsedMs: 20 * 60 * 1000, inputTokens: 400_000, outputTokens: 60_000 };

export class TeamError extends Error {
  constructor(code, message, blocked = null, unblock = null) {
    super(message);
    this.name = "TeamError";
    this.code = code;
    if (blocked) this.blocked = blocked;
    if (unblock) this.unblock = unblock;
  }
}

export function createTeamService({ family, delegation, missionService, platformStore, toolRegistry, client, model, workspace, leadName = "Product Executive" }) {
  const lead = () => {
    const agent = family.listAgents(TENANT).find((a) => a.name === leadName && family.isLive(a));
    if (!agent) throw new TeamError("NO_LEAD", `The ${leadName} is not available.`, "BLOCKED_BY_DEPENDENCY", "Restart Atlas so the agent organization is seeded.");
    return agent;
  };

  /** Working agents a plan may assign: live, non-root, non-oversight, and not a parent. */
  function roster() {
    const all = family.listAgents(TENANT, { state: ["authorized", "idle", "running"] });
    return all
      .filter((a) => a.parentId && a.family !== "oversight" && !all.some((c) => c.parentId === a.id))
      .map((a) => ({ id: a.id, name: a.name, family: a.family, role: a.role, tools: [...toolsForAgent(toolRegistry, a).names] }));
  }

  // Keep the platform task's lifecycle in step with the scheduler.
  const watched = new Set();
  function watch(missionId, platformTaskId) {
    if (watched.has(missionId)) return;
    watched.add(missionId);
    // Mission events carry their payload's fields at the top level.
    let stop = null;
    let settled = false;
    stop = missionService.subscribe(missionId, 0, (event) => {
      if (settled || !TERMINAL.has(event.status)) return;
      settled = true;
      settle(platformTaskId, event.snapshot);
      watched.delete(missionId);
      queueMicrotask(() => stop?.());
    });
  }

  function settle(platformTaskId, snapshot) {
    const task = platformStore.getTask(TENANT, platformTaskId);
    if (!task || ["completed", "failed", "cancelled", "archived"].includes(task.status)) return;
    const children = snapshot?.children ?? [];
    const verified = children.filter((c) => c.state === "completed").length;
    const actor = "atlas.team";
    if (snapshot?.status === "completed") {
      platformStore.transitionTask(TENANT, platformTaskId, "verifying", { actor, reason: "every step reported" });
      platformStore.transitionTask(TENANT, platformTaskId, "completed", { actor, reason: `${verified}/${children.length} steps verified`, result: { steps: children.map((c) => ({ id: c.id, title: c.metadata?.stepTitle, agent: c.metadata?.agentName, summary: c.result?.summary ?? null })) } });
    } else if (snapshot?.status === "cancelled") {
      platformStore.transitionTask(TENANT, platformTaskId, "cancelled", { actor, reason: "cancelled by the owner" });
    } else {
      const failed = children.find((c) => c.state === "failed");
      platformStore.transitionTask(TENANT, platformTaskId, "failed", { actor, reason: failed?.result?.summary ?? failed?.error?.message ?? "a step failed", error: { code: failed?.result?.code ?? failed?.error?.code ?? "STEP_FAILED", message: String(failed?.result?.summary ?? failed?.error?.message ?? "A step failed.").slice(0, 500) } });
    }
    const rootTaskId = rootTaskIdFor(snapshot);
    const leadAgentId = snapshot?.children?.[0]?.metadata?.leadAgentId;
    try {
      if (snapshot?.status === "completed") delegation.submitResult({ tenantId: TENANT, agentId: leadAgentId, taskId: rootTaskId, result: { steps: children.length }, verified: true });
      else delegation.cancelTask(TENANT, rootTaskId, { reason: `mission ${snapshot?.status}` });
    } catch { /* already closed */ }
  }

  const rootTaskIdFor = (snapshot) => snapshot?.children?.[0]?.metadata?.rootTaskId;

  return {
    roster,

    /** Goal → plan → running mission. Returns once the plan is scheduled. */
    async start({ goal, signal }) {
      const text = typeof goal === "string" ? goal.trim() : "";
      if (text.length < 8 || text.length > 4000) throw new TeamError("INVALID_GOAL", "Describe the goal in a sentence or more (up to 4,000 characters).");
      if (!client) throw new TeamError("NO_MODEL", "No model is configured to plan missions.", "BLOCKED_BY_CAPABILITY", "Set ATLAS_MODEL_ENDPOINT (or ATLAS_MODEL_ROUTES) to an OpenAI-compatible server such as Ollama.");
      const leadAgent = lead();
      const agents = roster();
      let planned;
      try {
        planned = await planMission({ client, model, goal: text, roster: agents, signal });
      } catch (error) {
        throw new TeamError(error.code ?? "PLAN_FAILED", `Atlas could not make a workable plan: ${error.message}`, "BLOCKED_BY_CAPABILITY", "Rephrase the goal more concretely, or use a stronger planning model.");
      }
      const missionId = `team-${randomUUID()}`;
      let task = platformStore.createTask({ tenantId: TENANT, userId: "local-owner", agentId: leadAgent.id, objective: text, successCriteria: planned.plan.successCriteria, budget: { toolCalls: STEP_BUDGET.toolCalls * planned.plan.steps.length } });
      task = platformStore.transitionTask(TENANT, task.id, "authorized", { actor: "local-owner", reason: "goal submitted by the owner" });
      task = platformStore.transitionTask(TENANT, task.id, "queued", { actor: "atlas.team", reason: planned.plan.summary || "plan ready" });
      task = platformStore.transitionTask(TENANT, task.id, "running", { actor: "atlas.team", reason: `${planned.plan.steps.length} step plan` });
      platformStore.recordUsage?.(TENANT, task.id, planned.usage);
      const rootTaskId = `mission:${missionId}`;
      delegation.assignTask({ tenantId: TENANT, agentId: leadAgent.id, taskId: rootTaskId, correlationId: task.correlationId, payload: { goal: text, missionId, platformTaskId: task.id } });
      const children = planned.plan.steps.map((step) => ({
        id: step.id,
        objective: step.title,
        dependencies: step.dependencies,
        budget: STEP_BUDGET,
        metadata: {
          kind: "agent_step", missionId, platformTaskId: task.id, rootTaskId, leadAgentId: leadAgent.id,
          agentId: step.agentId, agentName: step.agentName, stepTitle: step.title, instructions: step.instructions, doneWhen: step.doneWhen,
        },
      }));
      const mission = missionService.create({ id: missionId, title: text.slice(0, 200), repository: workspace, model, children, maxConcurrency: 2 });
      watch(missionId, task.id);
      return { mission, task, plan: planned.plan };
    },

    /** After a restart, keep the platform task in step with recovered missions. */
    reattach() {
      for (const mission of missionService.list()) {
        const meta = mission.children?.[0]?.metadata;
        if (meta?.kind === "agent_step" && !TERMINAL.has(mission.status)) watch(mission.id, meta.platformTaskId);
      }
    },

    list() {
      return missionService.list()
        .filter((m) => m.children?.[0]?.metadata?.kind === "agent_step")
        .map((m) => summarizeMission(m, platformStore));
    },

    detail(missionId) {
      const mission = missionService.get(missionId);
      const meta = mission?.children?.[0]?.metadata;
      if (!mission || meta?.kind !== "agent_step") return null;
      const taskId = meta.platformTaskId;
      return {
        ...summarizeMission(mission, platformStore),
        steps: mission.children.map((c) => ({
          id: c.id, title: c.metadata.stepTitle, agent: c.metadata.agentName, agentId: c.metadata.agentId, dependsOn: c.dependencies,
          doneWhen: c.metadata.doneWhen, state: c.state, attempts: c.attempts, usage: c.usage,
          // The scheduler keeps a failed child's report in error, not result.
          summary: c.result?.summary ?? c.error?.message ?? null,
          verified: c.state === "completed" ? (c.result?.evidence?.[0]?.verified ?? null) : c.state === "failed" ? false : null,
          error: c.error ?? null,
        })),
        messages: delegation.bus.listMessages(TENANT).filter((m) => m.taskId === meta.rootTaskId || m.taskId.startsWith(`${meta.rootTaskId}:`)).map((m) => ({
          type: m.type, from: family.getAgent(TENANT, m.source)?.name ?? m.source, to: family.getAgent(TENANT, m.destination)?.name ?? m.destination, taskId: m.taskId, at: m.createdAt,
        })),
        toolCalls: platformStore.getToolCalls(TENANT, taskId).map((c) => ({ id: c.id, tool: c.tool, agent: family.getAgent(TENANT, c.agentId)?.name ?? c.agentId, status: c.status, error: c.error, durationMs: c.durationMs, at: c.createdAt })),
        artifacts: platformStore.listArtifacts(TENANT, { taskId }).map((a) => ({ id: a.id, kind: a.kind, verification: a.verification, agent: a.content?.agent ?? null, step: a.content?.step ?? null, report: a.content?.report ?? null, evidence: a.verificationEvidence })),
        transitions: platformStore.listTransitions(TENANT, taskId),
      };
    },

    control(missionId, action) {
      const mission = missionService.get(missionId);
      if (!mission || mission.children?.[0]?.metadata?.kind !== "agent_step") throw new TeamError("UNKNOWN_MISSION", "Mission not found.");
      const updated = missionService.control(missionId, action);
      if (action === "resume") watch(missionId, mission.children[0].metadata.platformTaskId);
      return summarizeMission(updated, platformStore);
    },
  };
}

function summarizeMission(mission, platformStore) {
  const meta = mission.children?.[0]?.metadata ?? {};
  const task = meta.platformTaskId ? platformStore.getTask(TENANT, meta.platformTaskId) : null;
  const usage = mission.children.reduce((sum, c) => ({
    toolCalls: sum.toolCalls + (c.usage?.toolCalls ?? 0), inputTokens: sum.inputTokens + (c.usage?.inputTokens ?? 0), outputTokens: sum.outputTokens + (c.usage?.outputTokens ?? 0),
  }), { toolCalls: 0, inputTokens: 0, outputTokens: 0 });
  return {
    id: mission.id, goal: task?.objective ?? mission.title, status: mission.status, taskId: meta.platformTaskId ?? null, taskStatus: task?.status ?? null,
    steps: { total: mission.children.length, completed: mission.children.filter((c) => c.state === "completed").length, failed: mission.children.filter((c) => c.state === "failed").length },
    agents: [...new Set(mission.children.map((c) => c.metadata?.agentName).filter(Boolean))],
    usage, createdAt: task?.createdAt ?? null, updatedAt: task?.updatedAt ?? null,
  };
}
