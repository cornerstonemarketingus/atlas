import { budgetSchema, defineTool, TASK_STATES } from "../../../../../packages/atlas-contracts/src/index.mjs";

/**
 * Atlas capabilities exposed over MCP (blueprint §8). Deliberately narrow:
 * read task status, list tasks and artifacts, and create a *proposed* task.
 * Nothing here can authorize, run, cancel or transition a task — a proposed
 * task still has to go through the normal approval path inside Atlas.
 *
 * Every tool is an Atlas `defineTool` definition, so the PolicyEngine judges
 * it by name / risk / consequential exactly like any other platform tool, and
 * each carries an `outputSchema` that its structured result is validated
 * against before it leaves the server.
 */

const idArg = { type: "string", minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9_-]+$" };
const ts = { type: "string", maxLength: 64 };

export const taskSummarySchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "status", "objective", "createdAt", "updatedAt"],
  properties: {
    id: { type: "string" },
    status: { enum: TASK_STATES },
    objective: { type: "string", maxLength: 8000 },
    successCriteria: { type: "array", items: { type: "string" } },
    parentTaskId: { type: ["string", "null"] },
    createdAt: ts,
    updatedAt: ts,
  },
};

const artifactSummarySchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "taskId", "kind", "contentDigest", "verification", "createdAt"],
  properties: {
    id: { type: "string" },
    taskId: { type: "string" },
    kind: { type: "string" },
    mediaType: { type: ["string", "null"] },
    contentDigest: { type: "string" },
    verification: { type: "string" },
    createdAt: ts,
  },
};

function summarizeTask(task, { detail = false } = {}) {
  return {
    id: task.id,
    status: task.status,
    objective: task.objective,
    ...(detail ? { successCriteria: [...task.successCriteria], parentTaskId: task.parentTaskId ?? null } : {}),
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
}

function summarizeArtifact(a) {
  return { id: a.id, taskId: a.taskId, kind: a.kind, mediaType: a.mediaType ?? null, contentDigest: a.contentDigest, verification: a.verification, createdAt: a.createdAt };
}

export class AtlasToolNotFound extends Error {
  constructor(message) { super(message); this.code = "NOT_FOUND"; }
}

/**
 * @param {import("../task-store.mjs").PlatformTaskStore} store
 * @returns {Array<ReturnType<typeof defineTool> & { title: string, outputSchema: object }>}
 */
export function atlasMcpTools(store) {
  const withOutput = (definition, outputSchema, title) => Object.freeze({ ...defineTool(definition), outputSchema, title });
  return [
    withOutput({
      name: "atlas.status_lookup",
      description: "Look up the status of one Atlas task by id (current tenant only).",
      risk: "read",
      inputSchema: { type: "object", additionalProperties: false, required: ["taskId"], properties: { taskId: idArg } },
      async execute({ taskId }, { principal }) {
        const task = store.getTask(principal.tenantId, taskId);
        if (!task) throw new AtlasToolNotFound("Task not found.");
        return { output: { task: summarizeTask(task, { detail: true }) } };
      },
    }, { type: "object", additionalProperties: false, required: ["task"], properties: { task: taskSummarySchema } }, "Task status"),

    withOutput({
      name: "atlas.list_tasks",
      description: "List recent Atlas tasks in the current tenant, optionally filtered by status.",
      risk: "read",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: { status: { enum: TASK_STATES }, limit: { type: "integer", minimum: 1, maximum: 100 } },
      },
      async execute({ status, limit = 20 }, { principal }) {
        const tasks = store.listTasks(principal.tenantId, { ...(status ? { status } : {}), limit });
        return { output: { tasks: tasks.map((t) => summarizeTask(t)) } };
      },
    }, { type: "object", additionalProperties: false, required: ["tasks"], properties: { tasks: { type: "array", maxItems: 100, items: taskSummarySchema } } }, "List tasks"),

    withOutput({
      name: "atlas.create_task",
      description: "Propose a new Atlas task. The task is created in status 'proposed' and must be authorized inside Atlas before anything runs.",
      risk: "low",
      consequential: false,
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["objective", "successCriteria"],
        properties: {
          objective: { type: "string", minLength: 1, maxLength: 4000 },
          successCriteria: { type: "array", minItems: 1, maxItems: 16, items: { type: "string", minLength: 1, maxLength: 1000 } },
          budget: budgetSchema,
        },
      },
      async execute({ objective, successCriteria, budget = {} }, { principal }) {
        const task = store.createTask({
          tenantId: principal.tenantId,
          userId: principal.userId,
          agentId: principal.agentId ?? null,
          objective,
          successCriteria,
          budget,
        });
        if (task.status !== "proposed") throw new Error("Invariant violated: MCP-created task is not 'proposed'.");
        return { output: { task: summarizeTask(task, { detail: true }) } };
      },
    }, { type: "object", additionalProperties: false, required: ["task"], properties: { task: { ...taskSummarySchema, properties: { ...taskSummarySchema.properties, status: { const: "proposed" } } } } }, "Propose task"),

    withOutput({
      name: "atlas.list_artifacts",
      description: "List artifact metadata (no content) in the current tenant, optionally for one task.",
      risk: "read",
      inputSchema: { type: "object", additionalProperties: false, properties: { taskId: idArg } },
      async execute({ taskId }, { principal }) {
        if (taskId !== undefined && !store.getTask(principal.tenantId, taskId)) throw new AtlasToolNotFound("Task not found.");
        const artifacts = store.listArtifacts(principal.tenantId, taskId === undefined ? {} : { taskId });
        return { output: { artifacts: artifacts.slice(0, 200).map(summarizeArtifact) } };
      },
    }, { type: "object", additionalProperties: false, required: ["artifacts"], properties: { artifacts: { type: "array", maxItems: 200, items: artifactSummarySchema } } }, "List artifacts"),
  ];
}
