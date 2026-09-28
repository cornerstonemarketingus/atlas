/**
 * Command Center: everything Atlas is doing, in one list.
 *
 * Mission lanes (explicit coder lanes and team-mission steps, which run on
 * the same scheduler), Genesis builds, local coder tasks and Improve Atlas
 * runs are read from their own services and normalized into one item shape:
 *
 *   { kind, id, title, state, bucket, updatedAt, link, progress, lanes, actions }
 *
 * `bucket` orders the view: "attention" (failed, blocked, held, waiting on
 * the owner) first, then "running", "waiting", "done". `actions` lists only
 * what the item's current state allows, each with the endpoint that performs
 * it, so the page never offers a button the server would refuse.
 *
 * Read-only: the aggregator starts and controls nothing itself.
 */

const MISSION_ACTIVE = new Set(["pending", "running"]);
const MISSION_DONE = new Set(["completed", "failed", "cancelled"]);
const GENESIS_ACTIVE = new Set(["idea", "requirements", "planning", "scaffolding", "building", "verifying", "previewing", "repairing", "reviewing", "publishing"]);
const GENESIS_ATTENTION = new Set(["failed", "blocked"]);
const GENESIS_WAITING = new Set(["planned", "approved", "paused"]);
const DONE_LIMIT = 20;

/**
 * @param {{ missions?: object[], genesisProjects?: object[], tasks?: object[], selfImprove?: object | null, now?: number }} sources
 */
export function buildCommandCenter({ missions = [], genesisProjects = [], tasks = [], selfImprove = null, automations = [], now = Date.now() } = {}) {
  const items = [
    ...automations.filter((automation) => !automation.enabled && automation.consecutiveFailures > 0).map(automationItem),
    ...missions.map(missionItem),
    ...genesisProjects.map(genesisItem),
    ...tasks.map(taskItem),
    ...selfImproveItems(selfImprove),
  ];
  const order = { attention: 0, running: 1, waiting: 2, done: 3 };
  items.sort((left, right) => order[left.bucket] - order[right.bucket] || String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")));
  const done = items.filter((item) => item.bucket === "done");
  const counts = { attention: 0, running: 0, waiting: 0, done: done.length };
  for (const item of items) if (item.bucket !== "done") counts[item.bucket] += 1;
  let lanesRunning = 0;
  for (const item of items) for (const lane of item.lanes ?? []) if (lane.state === "running") lanesRunning += 1;
  return {
    generatedAt: new Date(now).toISOString(),
    counts: { ...counts, lanesRunning },
    items: [...items.filter((item) => item.bucket !== "done"), ...done.slice(0, DONE_LIMIT)],
  };
}

function missionItem(mission) {
  const team = mission.children?.[0]?.metadata?.kind === "agent_step";
  const lanes = (mission.children ?? []).map((child) => laneOf(mission, child, team));
  const held = lanes.some((lane) => lane.held);
  const failedLane = lanes.some((lane) => lane.state === "failed" || lane.state === "blocked");
  const bucket = mission.status === "failed" || mission.status === "interrupted" || held || (failedLane && !MISSION_DONE.has(mission.status))
    ? "attention"
    : mission.status === "running" ? "running"
      : MISSION_ACTIVE.has(mission.status) ? "waiting" : "done";
  const base = `/v1/missions/${encodeURIComponent(mission.id)}/control`;
  const actions = [];
  if (mission.status === "running") actions.push(action("pause", "Pause all", base), action("cancel", "Cancel", base));
  if (mission.status === "interrupted") actions.push(action("resume", "Resume", base), action("cancel", "Cancel", base));
  return {
    kind: team ? "team" : "mission",
    id: mission.id,
    title: mission.title || lanes[0]?.title || mission.id,
    state: mission.status,
    bucket,
    updatedAt: mission.completedAt ?? latest(lanes.map((lane) => lane.updatedAt)) ?? mission.startedAt ?? null,
    link: team ? `#/missions/${mission.id}` : "#/missions",
    detail: mission.reason ?? null,
    progress: { done: lanes.filter((lane) => lane.state === "completed").length, total: lanes.length },
    lanes,
    actions,
  };
}

function laneOf(mission, child, team) {
  const held = child.state === "interrupted" && child.error?.code === "CHILD_PAUSED";
  const base = `/v1/missions/${encodeURIComponent(mission.id)}/lanes/${encodeURIComponent(child.id)}/control`;
  const actions = [];
  if (child.state === "running" || child.state === "pending" || (child.state === "interrupted" && !held)) actions.push(action("pause", "Pause", base));
  if (held) actions.push(action("resume", "Resume", base));
  if (["running", "pending", "interrupted"].includes(child.state)) actions.push(action("cancel", "Cancel", base));
  if (["failed", "cancelled", "blocked"].includes(child.state) && !(mission.status === "cancelled" && child.error?.code === "MISSION_CANCELLED")) {
    actions.push(action("retry", "Retry", base));
  }
  if (child.state === "completed" && !team && child.result?.handoff?.patch) {
    actions.push({ name: "apply", label: child.metadata?.variant ? "Use this version" : "Apply to repository", method: "POST", path: base.replace(/\/control$/u, "/apply"), body: {} });
  }
  return {
    id: child.id,
    title: team ? (child.metadata?.stepTitle ?? child.objective)
      : child.metadata?.variant ? `Version ${child.metadata.variant} of ${child.metadata.variants}` : child.objective || child.id,
    agent: team ? child.metadata?.agentName ?? null : null,
    state: child.state,
    held,
    attempts: child.attempts,
    usage: child.usage ?? null,
    message: child.error?.message ?? null,
    // What a finished coder lane produced: its report and the patch from its isolated worktree.
    result: child.state === "completed" && child.result
      ? { summary: typeof child.result.summary === "string" ? child.result.summary.slice(0, 600) : null, patch: child.result.handoff?.patch ?? null, worktree: child.result.handoff?.worktree ?? null }
      : null,
    updatedAt: child.completedAt ?? child.startedAt ?? null,
    actions,
  };
}

/** Only automations that paused themselves need the owner here; their runs show as missions. */
function automationItem(automation) {
  const base = `/v1/automations/${encodeURIComponent(automation.id)}`;
  return {
    kind: "automation", id: automation.id, title: automation.name, state: "paused", bucket: "attention",
    updatedAt: automation.updatedAt ?? null, link: "#/automations", detail: automation.pausedReason ?? null, progress: null, lanes: [],
    actions: [{ name: "resume", label: "Resume", method: "POST", path: `${base}/resume`, body: {} }],
  };
}

function genesisItem(project) {
  const bucket = GENESIS_ATTENTION.has(project.state) ? "attention"
    : GENESIS_ACTIVE.has(project.state) ? "running"
      : GENESIS_WAITING.has(project.state) ? (project.state === "planned" ? "attention" : "waiting") : "done";
  const base = `/v1/genesis/${encodeURIComponent(project.id)}`;
  const actions = [];
  if (GENESIS_ACTIVE.has(project.state) || project.state === "approved") actions.push(action("pause", "Pause", `${base}/pause`));
  if (project.state === "paused") actions.push(action("resume", "Resume", `${base}/resume`));
  if (project.state === "failed") actions.push(action("retry", "Try again", `${base}/retry`));
  if (!["cancelled", "ready", "published"].includes(project.state)) actions.push(action("cancel", "Cancel", `${base}/cancel`));
  return {
    kind: "genesis",
    id: project.id,
    title: project.name,
    state: project.state,
    bucket,
    updatedAt: project.updatedAt ?? null,
    link: `#/build/${project.id}`,
    detail: project.state === "planned" ? "Plan waiting for your approval." : project.label ?? null,
    progress: null,
    lanes: [],
    actions,
  };
}

function taskItem(task) {
  const bucket = task.status === "failed" || task.status === "awaiting_approval" ? "attention"
    : task.status === "running" ? "running"
      : task.status === "queued" ? "waiting" : "done";
  return {
    kind: "task",
    id: task.id,
    title: task.objective,
    state: task.status,
    bucket,
    updatedAt: task.completedAt ?? task.startedAt ?? task.createdAt ?? null,
    link: "#/home",
    detail: task.message ?? task.repository ?? null,
    progress: null,
    lanes: [],
    actions: [],
  };
}

function selfImproveItems(status) {
  if (!status) return [];
  const items = [];
  if (status.running) {
    items.push({
      kind: "improve", id: "improve-run", title: "Improving Atlas", state: "running", bucket: "running",
      updatedAt: status.run?.startedAt ?? null, link: "#/improve", detail: status.log?.at(-1) ?? null, progress: null, lanes: [], actions: [],
    });
  }
  for (const entry of status.pending ?? []) {
    items.push({
      kind: "improve", id: `improve-${entry.id}`, title: entry.objective ?? entry.task ?? "Improvement ready for review", state: "awaiting_approval", bucket: "attention",
      updatedAt: entry.finishedAt ?? entry.at ?? null, link: "#/improve", detail: "Ready for your review.", progress: null, lanes: [], actions: [],
    });
  }
  return items;
}

function action(name, label, path) {
  return path.endsWith("/control") ? { name, label, method: "POST", path, body: { action: name } } : { name, label, method: "POST", path, body: {} };
}

function latest(values) {
  return values.filter(Boolean).sort().at(-1) ?? null;
}

/** GET /v1/command-center — any authenticated caller; every action goes through its own owner-only route. */
export function createCommandCenterRoutes({ missionService = null, genesis = null, store = null, selfImprove = null, automations = null, send }) {
  return function handle(request, response) {
    if (request.method !== "GET" || new URL(request.url ?? "/", "http://local.atlas").pathname !== "/v1/command-center") return false;
    const read = (fn, fallback) => { try { return fn() ?? fallback; } catch { return fallback; } };
    return send(response, 200, buildCommandCenter({
      missions: read(() => missionService?.list(), []),
      genesisProjects: read(() => genesis?.list(), []),
      tasks: read(() => store?.list(50), []),
      selfImprove: read(() => selfImprove?.status(), null),
      automations: read(() => automations?.list(), []),
    }));
  };
}
