import { digest, newId, validateSchema } from "../../../../../packages/atlas-contracts/src/index.mjs";
import { SkillApprovals, actorKey } from "./approvals.mjs";
import { SkillError } from "./package.mjs";

/**
 * Reusable workflow templates distilled from verified tasks (blueprint §13 O).
 *
 * Only a task that reached `completed` with at least one verified artifact
 * and no rejected one can become a template: a sequence of tool calls that
 * never proved its result is a guess, not a workflow. The template keeps the
 * task's succeeded tool calls in order and its success criteria; the user
 * names which input values become parameters (by step index and a dotted
 * path into that step's input), and each such value is replaced by a
 * `{ "$param": name }` placeholder. Everything else stays fixed.
 *
 * Drafting never saves: a draft becomes usable only after a human approves
 * exactly its digest. `instantiate` substitutes parameters (validated against
 * their schemas, unknown parameters refused) and validates every resulting
 * step against the named tool's input schema, producing a plan of tool calls.
 * It runs nothing.
 */
const PARAM_NAME = /^[a-z][a-zA-Z0-9_]{0,63}$/u;
const PLACEHOLDER = "$param";

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function splitPath(path) {
  if (typeof path !== "string" || !path) throw new SkillError("INVALID_TEMPLATE", "A parameter path must be a dotted path into a step input.");
  return path.split(".").map((segment) => (/^\d+$/u.test(segment) ? Number(segment) : segment));
}

function containsPlaceholderKey(value) {
  if (Array.isArray(value)) return value.some(containsPlaceholderKey);
  if (isPlainObject(value)) return PLACEHOLDER in value || Object.values(value).some(containsPlaceholderKey);
  return false;
}

function inferSchema(value) {
  if (typeof value === "string") return { type: "string", maxLength: 10_000 };
  if (Number.isInteger(value)) return { type: "integer" };
  if (typeof value === "number") return { type: "number" };
  if (typeof value === "boolean") return { type: "boolean" };
  if (Array.isArray(value)) return { type: "array" };
  if (isPlainObject(value)) return { type: "object" };
  return {};
}

function substitute(value, params) {
  if (Array.isArray(value)) return value.map((item) => substitute(item, params));
  if (isPlainObject(value)) {
    const keys = Object.keys(value);
    if (keys.length === 1 && keys[0] === PLACEHOLDER) return structuredClone(params[value[PLACEHOLDER]]);
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substitute(v, params)]));
  }
  return value;
}

/**
 * Pure instantiation. `resolveTool(name)` returns `{ inputSchema }` or null.
 * Returns `{ templateDigest, successCriteria, steps: [{ tool, input }] }`.
 */
export function instantiateTemplate(template, params, resolveTool) {
  if (!isPlainObject(params)) throw new SkillError("INVALID_PARAMS", "Parameters must be an object.");
  const schema = {
    type: "object",
    additionalProperties: false,
    required: template.parameters.map((p) => p.name),
    properties: Object.fromEntries(template.parameters.map((p) => [p.name, p.schema])),
  };
  const paramErrors = validateSchema(schema, params, "params");
  if (paramErrors.length > 0) {
    throw new SkillError("INVALID_PARAMS", `Parameters are invalid: ${paramErrors.map((e) => `${e.path} ${e.message}`).join("; ")}.`, paramErrors);
  }
  const steps = template.steps.map((step, index) => {
    const tool = typeof resolveTool === "function" ? resolveTool(step.tool) : null;
    if (!tool?.inputSchema) throw new SkillError("UNKNOWN_TOOL", `Step ${index} names tool '${step.tool}', which is not available.`);
    const input = substitute(step.input, params);
    const errors = validateSchema(tool.inputSchema, input, `steps[${index}].input`);
    if (errors.length > 0) {
      throw new SkillError("INVALID_PARAMS", `Step ${index} (${step.tool}) input is invalid: ${errors.map((e) => `${e.path} ${e.message}`).join("; ")}.`, errors);
    }
    return { tool: step.tool, input };
  });
  return { templateId: template.id ?? null, templateDigest: templateDigest(template), successCriteria: [...template.successCriteria], steps };
}

/** Digest of the parts of a template that define its behaviour. */
export function templateDigest(template) {
  return digest({
    name: template.name, description: template.description, parameters: template.parameters,
    steps: template.steps, successCriteria: template.successCriteria, source: template.source ?? null,
  });
}

/** `resolveTool` from an executor (`executor.list()`) or a list of tool definitions. */
export function toolResolver(source) {
  const list = typeof source?.list === "function" ? source.list() : source;
  const byName = new Map((list ?? []).map((tool) => [tool.name, tool]));
  return (name) => byName.get(name) ?? null;
}

export class WorkflowTemplates {
  #db;
  #taskStore;
  #clock;
  #resolveTool;
  approvals;

  constructor({ db, taskStore = null, resolveTool = () => null, approvals = undefined, clock = () => new Date() }) {
    this.#db = db;
    this.#taskStore = taskStore;
    this.#resolveTool = resolveTool;
    this.#clock = clock;
    this.approvals = approvals ?? new SkillApprovals({ db, clock });
    db.exec(`
      CREATE TABLE IF NOT EXISTS workflow_templates (
        id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, name TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('draft','saved')),
        template_json TEXT NOT NULL, template_digest TEXT NOT NULL, approval_id TEXT NOT NULL,
        drafted_by TEXT NOT NULL, saved_by TEXT, created_at TEXT NOT NULL, saved_at TEXT
      );
      CREATE INDEX IF NOT EXISTS workflow_templates_tenant ON workflow_templates(tenant_id, status);
    `);
  }

  /** The input schema source used by instantiate (`{ inputSchema }` or null). */
  resolveTool(name) {
    return this.#resolveTool(name);
  }

  /** Builds (but does not save) a template from a completed, verified task. */
  draftFromTask(tenantId, taskId, { name, description = "", parameters = [], draftedBy }) {
    if (!this.#taskStore) throw new SkillError("MISCONFIGURED", "Drafting from a task needs a task store.");
    const task = this.#taskStore.getTask(tenantId, taskId);
    if (!task) throw new SkillError("NOT_FOUND", "No such task in this tenant.");
    if (task.status !== "completed") throw new SkillError("TASK_NOT_VERIFIED", `Only a completed task can become a template; this one is '${task.status}'.`);
    const artifacts = this.#taskStore.listArtifacts(tenantId, { taskId });
    const verified = artifacts.filter((a) => a.verification === "verified");
    if (verified.length === 0) throw new SkillError("TASK_NOT_VERIFIED", "The task has no verified artifact; its outcome was never proven.");
    if (artifacts.some((a) => a.verification === "rejected")) throw new SkillError("TASK_NOT_VERIFIED", "The task has a rejected artifact.");
    const calls = this.#taskStore.getToolCalls(tenantId, taskId).filter((call) => call.status === "succeeded");
    if (calls.length === 0) throw new SkillError("TASK_NOT_VERIFIED", "The task has no succeeded tool calls to reuse.");
    const draft = buildTemplate({
      name, description, parameters, successCriteria: task.successCriteria,
      steps: calls.map((call) => ({ tool: call.tool, input: call.input })),
      source: { taskId, correlationId: task.correlationId, verifiedArtifacts: verified.map((a) => ({ id: a.id, contentDigest: a.contentDigest })) },
    });
    return this.#storeDraft(tenantId, draft, draftedBy);
  }

  /** Stores an already-built template (e.g. from an agent proposal) as a draft awaiting approval. */
  draftFromDefinition(tenantId, definition, { draftedBy }) {
    return this.#storeDraft(tenantId, buildTemplate(definition), draftedBy);
  }

  #storeDraft(tenantId, draft, draftedBy) {
    const id = `wft_${newId("artifact").slice(4)}`;
    const template = { id, ...draft };
    const hash = templateDigest(template);
    const approval = this.approvals.request({ tenantId, kind: "workflow.template.save", subjectDigest: hash, requestedBy: draftedBy, summary: `template '${template.name}'` });
    this.#db.prepare(
      `INSERT INTO workflow_templates (id, tenant_id, name, status, template_json, template_digest, approval_id, drafted_by, created_at)
       VALUES (?, ?, ?, 'draft', ?, ?, ?, ?, ?)`,
    ).run(id, tenantId, template.name, JSON.stringify(template), hash, approval.id, actorKey(draftedBy), this.#clock().toISOString());
    return { template: this.get(tenantId, id), approval };
  }

  save(tenantId, templateId, { approvalId, approvedBy }) {
    const current = this.get(tenantId, templateId);
    if (!current) throw new SkillError("NOT_FOUND", "No such template in this tenant.");
    if (current.status === "saved") throw new SkillError("ALREADY_SAVED", "The template is already saved.");
    const problem = approvedBy
      ? this.approvals.problem(tenantId, approvalId, { kind: "workflow.template.save", subjectDigest: current.digest, approvedBy })
      : "no approver was named";
    if (problem) throw new SkillError("APPROVAL_REQUIRED", `Saving a template requires human approval: ${problem}.`);
    if (!this.approvals.consume(tenantId, approvalId)) throw new SkillError("APPROVAL_REQUIRED", "The approval was used concurrently.");
    this.#db.prepare("UPDATE workflow_templates SET status = 'saved', saved_by = ?, saved_at = ? WHERE id = ? AND tenant_id = ? AND status = 'draft'")
      .run(actorKey(approvedBy), this.#clock().toISOString(), templateId, tenantId);
    return this.get(tenantId, templateId);
  }

  get(tenantId, templateId) {
    const row = this.#db.prepare("SELECT * FROM workflow_templates WHERE id = ? AND tenant_id = ?").get(templateId, tenantId);
    if (!row) return null;
    return { ...JSON.parse(row.template_json), status: row.status, digest: row.template_digest, approvalId: row.approval_id, draftedBy: row.drafted_by, savedBy: row.saved_by };
  }

  list(tenantId, { status = "saved" } = {}) {
    return this.#db.prepare("SELECT id FROM workflow_templates WHERE tenant_id = ? AND status = ? ORDER BY created_at, id").all(tenantId, status)
      .map((row) => this.get(tenantId, row.id));
  }

  /** Plan for a saved template. Re-checks the stored digest so an edited row is refused. */
  instantiate(tenantId, templateId, params) {
    const template = this.get(tenantId, templateId);
    if (!template) throw new SkillError("NOT_FOUND", "No such template in this tenant.");
    if (template.status !== "saved") throw new SkillError("NOT_SAVED", "A draft template cannot be instantiated until it is approved and saved.");
    if (templateDigest(template) !== template.digest) throw new SkillError("INTEGRITY_FAILURE", "The stored template no longer matches its approved digest.");
    return instantiateTemplate(template, params, this.#resolveTool);
  }
}

/** Validates a template definition and applies parameter extraction. */
export function buildTemplate({ name, description = "", parameters = [], steps, successCriteria, source = null }) {
  if (typeof name !== "string" || !name.trim() || name.length > 200) throw new SkillError("INVALID_TEMPLATE", "A template needs a name.");
  if (!Array.isArray(steps) || steps.length === 0) throw new SkillError("INVALID_TEMPLATE", "A template needs at least one step.");
  if (!Array.isArray(successCriteria) || successCriteria.length === 0) throw new SkillError("INVALID_TEMPLATE", "A template needs success criteria.");
  const workingSteps = steps.map((step, index) => {
    if (!isPlainObject(step) || typeof step.tool !== "string" || !isPlainObject(step.input)) throw new SkillError("INVALID_TEMPLATE", `Step ${index} needs a tool and an object input.`);
    if (containsPlaceholderKey(step.input)) throw new SkillError("INVALID_TEMPLATE", `Step ${index} input already uses the reserved key '${PLACEHOLDER}'.`);
    return { tool: step.tool, input: structuredClone(step.input) };
  });
  if (!Array.isArray(parameters)) throw new SkillError("INVALID_TEMPLATE", "parameters must be a list.");
  const declared = new Map();
  for (const parameter of parameters) {
    const { name: pname, step, path, schema = undefined, description: pdesc = "" } = parameter ?? {};
    if (!PARAM_NAME.test(pname ?? "")) throw new SkillError("INVALID_TEMPLATE", `Parameter name '${pname}' is malformed.`);
    if (!Number.isInteger(step) || step < 0 || step >= workingSteps.length) throw new SkillError("INVALID_TEMPLATE", `Parameter '${pname}' names step ${step}, which does not exist.`);
    const segments = splitPath(path);
    let parent = workingSteps[step].input;
    for (const segment of segments.slice(0, -1)) {
      parent = parent?.[segment];
      if (parent === null || typeof parent !== "object") throw new SkillError("INVALID_TEMPLATE", `Parameter '${pname}' path '${path}' does not exist in step ${step}.`);
    }
    const leaf = segments.at(-1);
    if (!(leaf in parent)) throw new SkillError("INVALID_TEMPLATE", `Parameter '${pname}' path '${path}' does not exist in step ${step}.`);
    const observed = parent[leaf];
    if (isPlainObject(observed) && PLACEHOLDER in observed) throw new SkillError("INVALID_TEMPLATE", `Path '${path}' of step ${step} is already a parameter.`);
    parent[leaf] = { [PLACEHOLDER]: pname };
    if (!declared.has(pname)) declared.set(pname, { name: pname, description: pdesc, schema: schema ?? inferSchema(observed), example: observed });
  }
  return {
    name: name.trim(), description, parameters: [...declared.values()], steps: workingSteps, successCriteria: [...successCriteria],
    ...(source ? { source } : {}),
  };
}
