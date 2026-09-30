import { randomUUID } from "node:crypto";

import { MissionScheduler } from "./mission-scheduler.mjs";
import { DEFAULT_BATCH_SIZE } from "./provider-throttle.mjs";

export class MissionServiceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "MissionServiceError";
    this.code = code;
  }
}

/**
 * Durable coordinator for dependency-aware missions.
 *
 * The service persists every scheduler snapshot before notifying observers.
 * On restart, in-flight work becomes interrupted and waits for an explicit
 * operator resume. That avoids silently replaying a consequential child whose
 * process may have completed just before the daemon stopped.
 */
export class MissionService {
  #store;
  #execute;
  #defaultConcurrency;
  #schedulers = new Map();
  #listeners = new Map();
  #decide;

  /** `decide({ objective, repository })` → { branch, variants, reasons } for strategy "auto" (the kernel's branching). */
  constructor({ store, execute, defaultConcurrency = DEFAULT_BATCH_SIZE, decide = null }) {
    this.#decide = decide;
    if (!store || typeof store.saveMission !== "function") throw new Error("A durable mission store is required.");
    if (typeof execute !== "function") throw new Error("A mission child executor is required.");
    if (!Number.isInteger(defaultConcurrency) || defaultConcurrency < 1 || defaultConcurrency > 8) {
      throw new Error("defaultConcurrency must be an integer from 1 to 8.");
    }
    this.#store = store;
    this.#execute = execute;
    this.#defaultConcurrency = defaultConcurrency;
  }

  recover() {
    const recovered = [];
    for (const row of this.#store.missions(10_000)) {
      if (["completed", "failed", "cancelled"].includes(row.status)) continue;
      const scheduler = this.#restore(row.snapshot);
      const snapshot = scheduler.snapshot();
      this.#persist(snapshot, "mission.recovered", "Interrupted mission registered; operator resume is required.");
      recovered.push(snapshot);
    }
    return recovered;
  }

  list() { return this.#store.missions().map((row) => publicMission(row.snapshot)); }

  get(id) {
    const snapshot = this.#schedulers.get(id)?.snapshot() ?? this.#store.mission(id)?.snapshot ?? null;
    return snapshot ? publicMission(snapshot) : null;
  }

  create({ id = randomUUID(), title = "", repository, model, children, tasks, objective, variants, strategy, maxConcurrency = this.#defaultConcurrency }) {
    // "auto": the kernel decides whether this objective runs as one lane or as competing versions.
    let decision = null;
    if (strategy === "auto" && children === undefined && tasks === undefined && variants === undefined) {
      if (typeof objective !== "string" || !objective.trim()) throw new MissionServiceError("INVALID_MISSION", "Describe what to do.");
      decision = this.#decide ? this.#decide({ objective: objective.trim(), repository: typeof repository === "string" ? repository.trim() : null }) : { branch: false, variants: 1, reasons: ["no strategy engine configured"] };
      if (decision.branch) variants = decision.variants;
      else tasks = [objective];
    } else if (strategy !== undefined && strategy !== "auto") {
      throw new MissionServiceError("INVALID_MISSION", 'strategy must be "auto" when given.');
    }
    if (children === undefined) ({ children, title } = expandLaunch({ tasks, objective, variants, title }));
    if (decision) children = children.map((child) => ({ ...child, metadata: { ...(child.metadata ?? {}), strategy: { decidedBy: "kernel", branch: decision.branch, reasons: decision.reasons } } }));
    if (this.get(id)) throw new MissionServiceError("MISSION_EXISTS", `Mission '${id}' already exists.`);
    if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1 || maxConcurrency > 8) {
      throw new MissionServiceError("INVALID_CONCURRENCY", "maxConcurrency must be an integer from 1 to 8.");
    }
    if (typeof repository !== "string" || repository.trim().length === 0 || repository.length > 4096) {
      throw new MissionServiceError("INVALID_MISSION", "A repository folder is required for a mission.");
    }
    if (typeof model !== "string" || model.trim().length === 0 || model.length > 200) {
      throw new MissionServiceError("INVALID_MISSION", "A model is required for a mission.");
    }
    const scopedChildren = Array.isArray(children) ? children.map((child) => ({
      ...child,
      metadata: { ...(child?.metadata ?? {}), repository: repository.trim(), model: model.trim() },
    })) : children;
    const scheduler = this.#build({ plan: { id, title, children: scopedChildren }, maxConcurrency });
    this.#schedulers.set(id, scheduler);
    const snapshot = scheduler.snapshot();
    this.#persist(snapshot, "mission.created", title || id);
    void scheduler.start().catch((error) => {
      this.#persist(scheduler.snapshot(), "mission.error", String(error?.message ?? error));
    });
    return publicMission(scheduler.snapshot());
  }

  control(id, action) {
    let scheduler = this.#schedulers.get(id);
    if (!scheduler) {
      const row = this.#store.mission(id);
      if (!row) throw new MissionServiceError("UNKNOWN_MISSION", "Mission not found.");
      scheduler = this.#restore(row.snapshot);
    }
    if (action === "pause") scheduler.pause();
    else if (action === "resume") void scheduler.resume();
    else if (action === "cancel") scheduler.cancel();
    else throw new MissionServiceError("INVALID_ACTION", "Mission action must be pause, resume, or cancel.");
    return publicMission(scheduler.snapshot());
  }

  /** Pause, resume, cancel or retry one lane of a mission (see MissionScheduler.controlChild). */
  controlLane(id, laneId, action) {
    let scheduler = this.#schedulers.get(id);
    if (!scheduler) {
      const row = this.#store.mission(id);
      if (!row) throw new MissionServiceError("UNKNOWN_MISSION", "Mission not found.");
      scheduler = this.#restore(row.snapshot);
    }
    if (!["pause", "resume", "cancel", "retry"].includes(action)) {
      throw new MissionServiceError("INVALID_ACTION", "Lane action must be pause, resume, cancel, or retry.");
    }
    try {
      scheduler.controlChild(laneId, action);
    } catch (error) {
      if (error?.code === "UNKNOWN_CHILD") throw new MissionServiceError("UNKNOWN_LANE", error.message);
      if (error?.code === "INVALID_STATE") throw new MissionServiceError("INVALID_STATE", error.message);
      throw error;
    }
    return publicMission(scheduler.snapshot());
  }

  events(id, { after = 0, limit = 500 } = {}) {
    if (!this.get(id)) throw new MissionServiceError("UNKNOWN_MISSION", "Mission not found.");
    return this.#store.missionEvents(id, { after, limit }).map(publicEvent);
  }

  subscribe(id, after, listener) {
    for (const event of this.events(id, { after })) listener(event);
    const listeners = this.#listeners.get(id) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(id, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.#listeners.delete(id);
    };
  }

  #build({ plan, maxConcurrency }) {
    return new MissionScheduler({
      plan,
      maxConcurrency,
      execute: this.#execute,
      onStateChange: (snapshot) => this.#persist(snapshot, "mission.updated", summarize(snapshot)),
    });
  }

  #restore(saved) {
    const scheduler = MissionScheduler.restore({
      snapshot: saved,
      execute: this.#execute,
      onStateChange: (snapshot) => this.#persist(snapshot, "mission.updated", summarize(snapshot)),
    });
    this.#schedulers.set(saved.plan.id, scheduler);
    return scheduler;
  }

  #persist(snapshot, kind, summary) {
    this.#store.saveMission(snapshot);
    const event = publicEvent(this.#store.appendMissionEvent(snapshot.plan.id, {
      type: kind,
      payload: { summary, status: snapshot.status, snapshot },
    }));
    for (const listener of this.#listeners.get(snapshot.plan.id) ?? []) listener(event);
  }
}

const MAX_LAUNCH_LANES = 8;
const MAX_VARIANTS = 5;
const MAX_OBJECTIVE = 10_000;

/**
 * Two ways to start parallel lanes without writing a lane plan:
 *
 * - `tasks`: one independent lane per task (each runs in its own worktree,
 *   so lanes on one repository do not collide);
 * - `objective` + `variants`: the same objective built N times in parallel,
 *   each told it is one of N versions, so the owner can compare them.
 */
export function expandLaunch({ tasks, objective, variants, title = "" }) {
  if (Array.isArray(tasks)) {
    const list = tasks.map((task) => (typeof task === "string" ? task.trim() : "")).filter(Boolean);
    if (list.length === 0) throw new MissionServiceError("INVALID_MISSION", "Give at least one task.");
    if (list.length > MAX_LAUNCH_LANES) throw new MissionServiceError("INVALID_MISSION", `At most ${MAX_LAUNCH_LANES} tasks run in one launch.`);
    if (list.some((task) => task.length > MAX_OBJECTIVE)) throw new MissionServiceError("INVALID_MISSION", "A task is too long.");
    return {
      title: title || (list.length === 1 ? list[0] : `${list.length} tasks in parallel`).slice(0, 200),
      children: list.map((task, index) => ({ id: `lane-${index + 1}`, objective: task, dependencies: [] })),
    };
  }
  if (variants !== undefined) {
    const count = Number(variants);
    const text = typeof objective === "string" ? objective.trim() : "";
    if (!Number.isInteger(count) || count < 2 || count > MAX_VARIANTS) throw new MissionServiceError("INVALID_MISSION", `variants must be a whole number from 2 to ${MAX_VARIANTS}.`);
    if (!text || text.length > MAX_OBJECTIVE) throw new MissionServiceError("INVALID_MISSION", "Describe what each version should do.");
    return {
      title: title || `${count} versions: ${text}`.slice(0, 200),
      children: Array.from({ length: count }, (_, index) => ({
        id: `version-${index + 1}`,
        objective: `${text}\n\n(Version ${index + 1} of ${count}. Other versions are being built in parallel for comparison; make your own design choices.)`,
        dependencies: [],
        metadata: { variant: index + 1, variants: count, request: text },
      })),
    };
  }
  throw new MissionServiceError("INVALID_MISSION", "Give lanes (children), a list of tasks, or an objective with a number of versions.");
}

function publicEvent(event) {
  return {
    sequence: event.sequence,
    id: event.id,
    missionId: event.missionId,
    kind: event.type,
    createdAt: event.createdAt,
    ...event.payload,
  };
}

function publicMission(snapshot) {
  const target = snapshot.children?.[0]?.metadata ?? {};
  return {
    ...snapshot,
    id: snapshot.plan.id,
    title: snapshot.plan.title,
    repository: target.repository ?? null,
    model: target.model ?? null,
  };
}

function summarize(snapshot) {
  const counts = {};
  for (const child of snapshot.children) counts[child.state] = (counts[child.state] ?? 0) + 1;
  return Object.entries(counts).map(([state, count]) => `${count} ${state}`).join(", ") || snapshot.status;
}
