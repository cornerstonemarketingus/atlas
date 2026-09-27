import { ACTIVE_STATES, STATE_LABELS } from "./lifecycle.mjs";
import { applyChangeRequest, inferSpecification } from "./requirements.mjs";
import { executionOrder, planProject } from "./planner.mjs";
import { isPlanShape, isSpecShape, resolveIntelligence } from "./intelligence.mjs";
import { GenesisStoreError } from "./store.mjs";

/**
 * Project Genesis orchestration: the owner's idea becomes a durable project
 * that moves through the lifecycle with evidence at every step.
 *
 * This slice owns understanding and planning (idea → requirements → planned
 * → approved), conversational changes, pause/resume/cancel, and recovery
 * after a restart. Execution stages (scaffolding onward) are driven by the
 * executor that plugs in through `advance()`, which enforces the same
 * lifecycle rules and records the same evidence.
 *
 * Plan approval: building locally is harmless (it only writes inside the
 * project workspace), so a plan with no open questions is approved
 * automatically while the owner's `genesis.plan` policy is "allow" (the
 * default); set it to "ask" to approve each plan yourself.
 * Consequential actions later (publishing, credentials, paid services) go
 * through Atlas's existing approval system, not this service.
 */

export class GenesisError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "GenesisError";
    this.code = code;
  }
}

const MAX_PROMPT = 4_000;

export class GenesisService {
  /**
   * @param {{ store: import("./store.mjs").GenesisStore, tenantId?: string, intelligence?: object,
   *   policy?: (capability: string) => { decision: string }, onChange?: (project: object) => void }} options
   */
  constructor({ store, tenantId = "local", intelligence = null, policy = () => ({ decision: "allow" }), onChange = () => {} }) {
    this.store = store;
    this.tenantId = tenantId;
    this.intelligence = resolveIntelligence(intelligence);
    this.policy = policy;
    this.onChange = onChange;
  }

  #emit(project) {
    try { this.onChange(project); } catch { /* observers never break a transition */ }
    return project;
  }

  #move(id, to, details) {
    return this.#emit(this.store.transition(this.tenantId, id, to, details));
  }

  /** The full picture of a project: state, spec, plan, tasks, history and a plain-language progress list. */
  view(id) {
    const project = this.store.get(this.tenantId, id);
    const transitions = this.store.transitions(this.tenantId, id);
    const tasks = this.store.tasks(this.tenantId, id);
    return { ...project, label: STATE_LABELS[project.state], tasks, transitions, progress: progressOf(project, tasks, transitions) };
  }

  list() {
    return this.store.list(this.tenantId).map((project) => ({ id: project.id, name: project.name, state: project.state, label: STATE_LABELS[project.state], updatedAt: project.updatedAt }));
  }

  async #specify(prompt, answers) {
    const draft = inferSpecification(prompt, { answers });
    let spec = draft;
    let refinedBy = "deterministic";
    try {
      const refined = await this.intelligence.refineSpecification({ prompt, draft });
      if (refined !== draft && isSpecShape(refined)) { spec = refined; refinedBy = this.intelligence.name ?? "intelligence"; }
    } catch { /* keep the deterministic draft */ }
    return { spec, refinedBy };
  }

  async #plan(spec) {
    const draft = planProject(spec);
    let plan = draft;
    let refinedBy = "deterministic";
    try {
      const refined = await this.intelligence.refinePlan({ spec, draft });
      if (refined !== draft && isPlanShape(refined)) { executionOrder(refined.tasks); plan = refined; refinedBy = this.intelligence.name ?? "intelligence"; }
    } catch { /* keep the deterministic plan */ }
    executionOrder(plan.tasks);
    return { plan, refinedBy };
  }

  /** "Build me …": creates the project, writes requirements, and plans unless a material question is open. */
  async create(prompt, { actor = "owner" } = {}) {
    const text = String(prompt ?? "").trim();
    if (!text) throw new GenesisError("PROMPT_REQUIRED", "Describe what to build.");
    if (text.length > MAX_PROMPT) throw new GenesisError("PROMPT_TOO_LONG", `Keep the description under ${MAX_PROMPT} characters.`);
    const { spec, refinedBy } = await this.#specify(text, {});
    let project = this.store.create({ tenantId: this.tenantId, prompt: text, name: spec.name, actor });
    project = this.#move(project.id, "requirements", {
      reason: `Requirements written (${spec.pages.length} pages, ${spec.entities.length} record types, ${spec.acceptanceCriteria.length} acceptance criteria).`,
      evidence: { kind: "specification", refinedBy, assumptions: spec.assumptions, questions: spec.questions },
      patch: { spec, name: spec.name },
    });
    return this.#afterRequirements(project);
  }

  async #afterRequirements(project) {
    const spec = project.spec;
    if (spec.questions.length) {
      return this.view(this.#move(project.id, "blocked", {
        reason: `Waiting for ${spec.questions.length === 1 ? "one answer" : `${spec.questions.length} answers`} that change what Atlas builds.`,
        evidence: { kind: "questions", questions: spec.questions },
      }).id);
    }
    const { plan, refinedBy } = await this.#plan(spec);
    this.store.replaceTasks(this.tenantId, project.id, plan.tasks);
    const planned = this.#move(project.id, "planned", {
      reason: `Planned ${plan.summary}.`,
      evidence: { kind: "plan", refinedBy, template: plan.template, tasks: plan.tasks.map((t) => ({ id: t.id, title: t.title, executor: t.executor })) },
      patch: { plan: { template: plan.template, summary: plan.summary } },
    });
    if (this.policy("genesis.plan").decision === "allow") {
      return this.view(this.#move(planned.id, "approved", {
        reason: "Approved automatically: building locally only writes inside the project folder.",
        evidence: { kind: "approval", policy: "genesis.plan", decision: "allow" },
        actor: "policy",
      }).id);
    }
    return this.view(planned.id);
  }

  /** Answers to the open questions; unblocks and re-plans. */
  async answer(id, answers, { actor = "owner" } = {}) {
    const project = this.store.get(this.tenantId, id);
    if (project.state !== "blocked" || project.resumeTo !== "requirements") throw new GenesisError("NOT_WAITING", "This project is not waiting for answers.");
    const clean = Object.fromEntries(Object.entries(answers ?? {}).filter(([key, value]) => /^[a-z-]{1,40}$/u.test(key) && typeof value === "string" && value.trim()).map(([key, value]) => [key, value.trim().slice(0, 500)]));
    const merged = { ...(project.spec.answers ?? {}), ...clean };
    const open = project.spec.questions.filter((q) => !(q.id in merged));
    if (open.length) throw new GenesisError("ANSWERS_MISSING", `Still needed: ${open.map((q) => q.id).join(", ")}.`);
    const { spec, refinedBy } = await this.#specify(project.prompt, merged);
    const resumed = this.#move(id, "requirements", {
      reason: "Requirements updated with your answers.",
      evidence: { kind: "answers", answers: clean, refinedBy },
      patch: { spec },
      actor,
    });
    return this.#afterRequirements(resumed);
  }

  approve(id, { actor = "owner" } = {}) {
    const project = this.store.get(this.tenantId, id);
    if (project.state !== "planned") throw new GenesisError("NOT_PLANNED", "Only a planned project can be approved.");
    return this.view(this.#move(id, "approved", { reason: "The owner approved the plan.", evidence: { kind: "approval", decision: "approved" }, actor }).id);
  }

  /**
   * A change to an existing project ("Add Google login"): the spec is updated,
   * the change is re-planned, and the project goes back through the build and
   * verification it already passed. Nothing starts over from scratch.
   */
  async change(id, request, { actor = "owner" } = {}) {
    const project = this.store.get(this.tenantId, id);
    if (!["ready", "published", "planned", "approved", "failed"].includes(project.state)) {
      throw new GenesisError("BUSY", `Atlas is ${STATE_LABELS[project.state].toLowerCase()}; pause it or wait before changing the plan.`);
    }
    const { spec, changes } = applyChangeRequest(project.spec, request);
    const moved = this.#move(id, "requirements", {
      reason: `Change requested: ${changes.map((c) => c.summary).join("; ")}.`,
      evidence: { kind: "change", request: String(request).slice(0, 1000), changes },
      patch: { spec },
      actor,
    });
    return this.#afterRequirements(moved);
  }

  /**
   * Execution stages move through here, so the executor (scaffolding, build,
   * verification, preview, review) is held to the same lifecycle and evidence
   * rules as planning.
   */
  advance(id, to, { reason, evidence = {}, patch = {}, expectedVersion = undefined, actor = "atlas" }) {
    return this.#move(id, to, { reason, evidence, patch, expectedVersion, actor });
  }

  pause(id, { actor = "owner" } = {}) {
    return this.#move(id, "paused", { reason: "Paused by the owner.", evidence: { kind: "control" }, actor });
  }

  resume(id, { actor = "owner" } = {}) {
    const project = this.store.get(this.tenantId, id);
    if (project.state !== "paused") throw new GenesisError("NOT_PAUSED", "Only a paused project can be resumed.");
    return this.#move(id, project.resumeTo, { reason: `Resumed ${STATE_LABELS[project.resumeTo].toLowerCase()}.`, evidence: { kind: "control" }, actor });
  }

  cancel(id, { actor = "owner" } = {}) {
    return this.#move(id, "cancelled", { reason: "Cancelled by the owner.", evidence: { kind: "control" }, actor });
  }

  /**
   * After a restart nothing is still running, so a project caught mid-work is
   * paused with the reason recorded; resuming continues from that stage.
   * Claiming it is still "building" would be a lie the UI would repeat.
   */
  recover() {
    return this.store.interrupted().filter((project) => project.tenantId === this.tenantId).map((project) => this.#move(project.id, "paused", {
      reason: `Atlas restarted while ${STATE_LABELS[project.state].toLowerCase()}; resume to continue.`,
      evidence: { kind: "recovery", interruptedState: project.state },
      actor: "recovery",
    }));
  }
}

/** A short, jargon-free progress list derived from durable state (never from UI state). */
export function progressOf(project, tasks, transitions) {
  const reached = new Set(transitions.map((t) => t.to));
  const steps = [
    { label: "Understanding your idea", done: reached.has("requirements") },
    { label: project.spec ? `Requirements: ${project.spec.pages.length} pages, ${project.spec.entities.length} record types` : "Requirements", done: reached.has("planned") || reached.has("blocked") },
    { label: project.plan ? `Plan: ${tasks.length} tasks` : "Planning", done: reached.has("planned") },
    ...tasks.map((t) => ({ label: t.title, done: t.status === "passed", status: t.status, attempts: t.attempts })),
    { label: "Ready", done: project.state === "ready" || project.state === "published" },
  ];
  const current = ACTIVE_STATES.includes(project.state) ? STATE_LABELS[project.state] : null;
  return { state: project.state, label: STATE_LABELS[project.state], current, steps };
}

export { GenesisStoreError };
