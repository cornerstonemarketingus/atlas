/**
 * Pure task/run reconciliation: resolving which GitHub Actions run belongs to
 * which dispatched task, and mapping a run's state onto the status the
 * dashboard shows.
 *
 * Kept schema-import-free (and fetch-free) so it can be unit-tested under plain
 * `node --test` without the bundler — the same split as
 * app/api/billing/period.mjs.
 */

/** The head branch scripts/runner/create-coder-pull-request.mjs pushes for a coder task. */
export function coderBranchForTask(taskId) {
  return `atlas/task-${taskId}`;
}

/**
 * Accepts both `new Date().toISOString()` and SQLite's `CURRENT_TIMESTAMP`
 * shape ("YYYY-MM-DD HH:MM:SS", which is UTC but carries no zone marker and
 * would otherwise be parsed as local time). Returns epoch ms, or null.
 */
export function parseTimestamp(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const normalized = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d+)?$/u.test(trimmed)
    ? `${trimmed.replace(" ", "T")}Z`
    : trimmed;
  const parsed = Date.parse(normalized);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * How long after a dispatch a run may still be considered that dispatch's run.
 * GitHub creates the run within a second or two, but the runs list API can lag,
 * so the window is generous on the late side and only tolerates a small amount
 * of clock skew on the early side.
 */
export const RUN_MATCH_WINDOW_MS = 15 * 60 * 1000;
export const RUN_MATCH_CLOCK_SKEW_MS = 90 * 1000;

/**
 * Resolves run ids for tasks that don't have one yet.
 *
 * WHY THIS IS A HEURISTIC, AND WHERE IT BREAKS
 * --------------------------------------------
 * `POST /actions/workflows/{id}/dispatches` returns 204 with an empty body, so
 * the run id is genuinely unknown at dispatch time. The runs list API does not
 * expose the `workflow_dispatch` inputs either, so there is no `task_id` on the
 * run to match against — the only signals available are the workflow the run
 * belongs to, its event, and when it was created.
 *
 * So: candidate runs are filtered to the same workflow and the
 * `workflow_dispatch` event, then tasks and runs are each sorted oldest-first
 * and matched greedily in order, one run per task, within the time window. When
 * dispatches are spaced out at all, this is exact — GitHub creates runs in the
 * order the dispatches arrive.
 *
 * It is NOT exact when:
 *   1. Two dispatches of the SAME workflow in the SAME repository land within
 *      the window and GitHub creates their runs out of order (network reorder,
 *      or two Atlas instances dispatching concurrently). The two tasks can then
 *      be attributed each other's run — same workflow and inputs modulo the
 *      objective, so the user sees a live run that isn't theirs.
 *   2. Someone triggers the same workflow from the GitHub UI inside the window.
 *      That run is also a `workflow_dispatch` and can be claimed by a task.
 *   3. The run has not appeared in the list API yet — then nothing matches and
 *      the task stays "dispatched" until the next poll. This is the common,
 *      benign case.
 *
 * Consequence of (1) and (2): a run/PR link can point at the wrong run. It
 * cannot leak across tenants — the caller only ever matches a user's own task
 * rows — but it can mis-attribute two runs inside one repository. The exact fix
 * is a `run-name:` expression in the workflow file carrying the task id, which
 * lives outside this app; until then this stays a documented approximation, and
 * once a task has a run id the id is persisted and never re-derived.
 *
 * @param {Array<{taskId: string, createdAt: string, workflow?: string|null, githubRunId?: number|null}>} taskRows
 * @param {Array<{id: number, createdAt: string, event?: string, workflow?: string|null}>} runs
 * @returns {Array<{taskId: string, runId: number}>} newly resolved assignments only
 */
export function assignRunsToTasks(taskRows, runs, options = {}) {
  const windowMs = options.windowMs ?? RUN_MATCH_WINDOW_MS;
  const skewMs = options.clockSkewMs ?? RUN_MATCH_CLOCK_SKEW_MS;

  const alreadyClaimed = new Set(
    (taskRows ?? []).map((row) => row?.githubRunId).filter((id) => typeof id === "number" && Number.isFinite(id)),
  );

  const candidates = (runs ?? [])
    .filter((run) => run && typeof run.id === "number" && Number.isFinite(run.id) && !alreadyClaimed.has(run.id))
    // Runs from push/pull_request/schedule can never be an Atlas dispatch.
    .filter((run) => run.event === undefined || run.event === null || run.event === "workflow_dispatch")
    .map((run) => ({ id: run.id, workflow: run.workflow ?? null, createdAt: parseTimestamp(run.createdAt) }))
    .filter((run) => run.createdAt !== null)
    .sort((left, right) => left.createdAt - right.createdAt || left.id - right.id);

  const pending = (taskRows ?? [])
    .filter((row) => row && typeof row.taskId === "string")
    .filter((row) => typeof row.githubRunId !== "number" || !Number.isFinite(row.githubRunId))
    .map((row) => ({ taskId: row.taskId, workflow: row.workflow ?? null, createdAt: parseTimestamp(row.createdAt) }))
    .filter((row) => row.createdAt !== null)
    .sort((left, right) => left.createdAt - right.createdAt);

  const used = new Set();
  const assignments = [];
  for (const task of pending) {
    const match = candidates.find(
      (run) =>
        !used.has(run.id) &&
        (task.workflow === null || run.workflow === null || run.workflow === task.workflow) &&
        run.createdAt >= task.createdAt - skewMs &&
        run.createdAt <= task.createdAt + windowMs,
    );
    if (!match) continue;
    used.add(match.id);
    assignments.push({ taskId: task.taskId, runId: match.id });
  }
  return assignments;
}

/**
 * Anything that is not an explicit success maps to a non-success status: a run
 * whose conclusion we don't recognise is reported as "failed" rather than
 * optimistically shown as done.
 */
const STATUS_BY_CONCLUSION = {
  success: "succeeded",
  failure: "failed",
  startup_failure: "failed",
  timed_out: "timed_out",
  cancelled: "cancelled",
  stale: "cancelled",
  skipped: "skipped",
  neutral: "skipped",
  action_required: "action_required",
};

const IN_FLIGHT_STATUSES = new Set(["queued", "waiting", "requested", "pending"]);

/**
 * Maps a GitHub Actions run onto the status Atlas shows. `null`/undefined means
 * no run has been resolved yet, which is "dispatched" — the workflow was
 * accepted but we cannot yet point at the run.
 */
export function taskStatusFromRun(run) {
  if (!run || typeof run !== "object") return "dispatched";
  const status = typeof run.status === "string" ? run.status : "";
  if (IN_FLIGHT_STATUSES.has(status)) return "queued";
  if (status === "in_progress") return "running";
  if (status !== "completed") return "dispatched";
  const conclusion = typeof run.conclusion === "string" ? run.conclusion : "";
  return STATUS_BY_CONCLUSION[conclusion] ?? "failed";
}

/** True once the run has stopped, i.e. nothing more will change. */
export function isTerminalStatus(status) {
  return status !== "dispatched" && status !== "queued" && status !== "running";
}

/** Deterministic run URL, so a link survives GitHub omitting `html_url`. */
export function runUrl(repository, runId) {
  if (typeof repository !== "string" || !/^[^/\s]+\/[^/\s]+$/u.test(repository)) return null;
  if (typeof runId !== "number" || !Number.isFinite(runId)) return null;
  const [owner, name] = repository.split("/");
  return `https://github.com/${owner}/${name}/actions/runs/${runId}`;
}

/**
 * The row-level owner key a task is stored under and listed by: the principal
 * string from `authenticatedAccount()`, never the nullable `users.id`.
 *
 * The operator-token and platform-header paths both have `dbUserId === null`,
 * but they are NOT one tenant: every distinct `oai-authenticated-user-id` is a
 * different customer. Keying on `userId` keeps them apart ("operator" vs the
 * platform id vs "github:<login>"), which a nullable numeric column cannot do.
 */
export function taskOwnerKey(account) {
  if (!account || typeof account.userId !== "string" || account.userId === "") return null;
  return account.userId;
}

/**
 * Defence in depth on top of the SQL `where`: re-filters rows to the caller, so
 * a future query change that widened the result set still could not show one
 * customer another's objectives.
 */
export function visibleTasks(rows, account) {
  const owner = taskOwnerKey(account);
  if (owner === null) return [];
  return (rows ?? []).filter((row) => row && typeof row.requestedBy === "string" && row.requestedBy === owner);
}
