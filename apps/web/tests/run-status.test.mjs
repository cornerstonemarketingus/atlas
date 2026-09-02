import assert from "node:assert/strict";
import test from "node:test";
import {
  assignRunsToTasks,
  coderBranchForTask,
  isTerminalStatus,
  parseTimestamp,
  runUrl,
  taskOwnerKey,
  taskStatusFromRun,
  visibleTasks,
} from "../app/api/tasks/run-status.mjs";
import { authenticatedAccount } from "../app/api/tasks/operator-auth.mjs";
import { signSession, sessionCookieHeader } from "../app/api/auth/session.mjs";

const BASE = "2026-09-01T12:00:00.000Z";
const BASE_MS = Date.parse(BASE);
const at = (offsetMs) => new Date(BASE_MS + offsetMs).toISOString();

test("parses ISO timestamps and SQLite's zone-less CURRENT_TIMESTAMP as UTC", () => {
  assert.equal(parseTimestamp(BASE), BASE_MS);
  assert.equal(parseTimestamp("2026-09-01 12:00:00"), BASE_MS);
  assert.equal(parseTimestamp("  2026-09-01T12:00:00.000Z  "), BASE_MS);
  assert.equal(parseTimestamp("not a date"), null);
  assert.equal(parseTimestamp(""), null);
  assert.equal(parseTimestamp(undefined), null);
});

test("matches a dispatched task to the run created just after it", () => {
  const assignments = assignRunsToTasks(
    [{ taskId: "a", createdAt: BASE, workflow: "atlas-runner.yml", githubRunId: null }],
    [{ id: 900, createdAt: at(3_000), event: "workflow_dispatch", workflow: "atlas-runner.yml" }],
  );
  assert.deepEqual(assignments, [{ taskId: "a", runId: 900 }]);
});

test("pairs several tasks with several runs in dispatch order, one run each", () => {
  const assignments = assignRunsToTasks(
    [
      { taskId: "second", createdAt: at(30_000), workflow: "atlas-runner.yml", githubRunId: null },
      { taskId: "first", createdAt: at(0), workflow: "atlas-runner.yml", githubRunId: null },
    ],
    [
      { id: 2, createdAt: at(31_000), event: "workflow_dispatch", workflow: "atlas-runner.yml" },
      { id: 1, createdAt: at(1_000), event: "workflow_dispatch", workflow: "atlas-runner.yml" },
    ],
  );
  assert.deepEqual(assignments, [{ taskId: "first", runId: 1 }, { taskId: "second", runId: 2 }]);
});

test("never hands the same run to two tasks, and skips runs another task already owns", () => {
  const assignments = assignRunsToTasks(
    [
      { taskId: "already", createdAt: at(0), workflow: "atlas-runner.yml", githubRunId: 1 },
      { taskId: "pending", createdAt: at(1_000), workflow: "atlas-runner.yml", githubRunId: null },
    ],
    [
      { id: 1, createdAt: at(500), event: "workflow_dispatch", workflow: "atlas-runner.yml" },
      { id: 2, createdAt: at(2_000), event: "workflow_dispatch", workflow: "atlas-runner.yml" },
    ],
  );
  assert.deepEqual(assignments, [{ taskId: "pending", runId: 2 }]);
});

test("leaves a task unmatched when the run has not appeared yet", () => {
  assert.deepEqual(assignRunsToTasks([{ taskId: "a", createdAt: BASE, githubRunId: null }], []), []);
});

test("refuses runs outside the window, before the dispatch, or from another workflow or event", () => {
  const task = [{ taskId: "a", createdAt: BASE, workflow: "atlas-coder.yml", githubRunId: null }];
  const run = (overrides) => [{ id: 5, createdAt: at(2_000), event: "workflow_dispatch", workflow: "atlas-coder.yml", ...overrides }];
  assert.deepEqual(assignRunsToTasks(task, run({ createdAt: at(60 * 60_000) })), []);
  assert.deepEqual(assignRunsToTasks(task, run({ createdAt: at(-10 * 60_000) })), []);
  assert.deepEqual(assignRunsToTasks(task, run({ workflow: "atlas-runner.yml" })), []);
  assert.deepEqual(assignRunsToTasks(task, run({ event: "push" })), []);
  // A little clock skew between D1 and GitHub is still a match.
  assert.deepEqual(assignRunsToTasks(task, run({ createdAt: at(-30_000) })), [{ taskId: "a", runId: 5 }]);
});

test("documents its failure mode: same-workflow runs created out of order are swapped", () => {
  // GitHub created the runs in the opposite order to the dispatches. The
  // heuristic has nothing but creation time to go on, so it pairs them the
  // wrong way round. This is the known, accepted inaccuracy — recorded here so
  // the day it stops being acceptable, the test says exactly what broke.
  const assignments = assignRunsToTasks(
    [
      { taskId: "dispatched-first", createdAt: at(0), workflow: "atlas-runner.yml", githubRunId: null },
      { taskId: "dispatched-second", createdAt: at(1_000), workflow: "atlas-runner.yml", githubRunId: null },
    ],
    [
      { id: 77, createdAt: at(400), event: "workflow_dispatch", workflow: "atlas-runner.yml" },
      { id: 88, createdAt: at(2_000), event: "workflow_dispatch", workflow: "atlas-runner.yml" },
    ],
  );
  assert.deepEqual(assignments, [{ taskId: "dispatched-first", runId: 77 }, { taskId: "dispatched-second", runId: 88 }]);
});

test("maps GitHub run states onto the statuses the dashboard shows", () => {
  assert.equal(taskStatusFromRun(null), "dispatched");
  assert.equal(taskStatusFromRun({ status: "queued" }), "queued");
  assert.equal(taskStatusFromRun({ status: "waiting" }), "queued");
  assert.equal(taskStatusFromRun({ status: "in_progress" }), "running");
  assert.equal(taskStatusFromRun({ status: "completed", conclusion: "success" }), "succeeded");
  assert.equal(taskStatusFromRun({ status: "completed", conclusion: "failure" }), "failed");
  assert.equal(taskStatusFromRun({ status: "completed", conclusion: "timed_out" }), "timed_out");
  assert.equal(taskStatusFromRun({ status: "completed", conclusion: "cancelled" }), "cancelled");
  assert.equal(taskStatusFromRun({ status: "completed", conclusion: "action_required" }), "action_required");
});

test("never reports an unrecognised conclusion as success", () => {
  assert.equal(taskStatusFromRun({ status: "completed", conclusion: "something_new" }), "failed");
  assert.equal(taskStatusFromRun({ status: "completed", conclusion: null }), "failed");
});

test("knows which statuses are still moving", () => {
  assert.equal(isTerminalStatus("running"), false);
  assert.equal(isTerminalStatus("queued"), false);
  assert.equal(isTerminalStatus("dispatched"), false);
  assert.equal(isTerminalStatus("succeeded"), true);
  assert.equal(isTerminalStatus("failed"), true);
});

test("builds run URLs and the coder head branch deterministically", () => {
  assert.equal(runUrl("cornerstonemarketingus/atlas", 42), "https://github.com/cornerstonemarketingus/atlas/actions/runs/42");
  assert.equal(runUrl("not-a-repository", 42), null);
  assert.equal(runUrl("owner/repo", null), null);
  assert.equal(coderBranchForTask("abc-123"), "atlas/task-abc-123");
});

test("keys task ownership on the principal, not the nullable database user id", async () => {
  const environment = { ATLAS_OPERATOR_TOKEN: "secret", ATLAS_SESSION_SECRET: "session-secret" };
  const url = "http://localhost/api/tasks";
  const alice = await authenticatedAccount(new Request(url, { headers: { "oai-authenticated-user-id": "platform-alice" } }), environment);
  const bob = await authenticatedAccount(new Request(url, { headers: { "oai-authenticated-user-id": "platform-bob" } }), environment);
  const operator = await authenticatedAccount(new Request(url, { headers: { authorization: "Bearer secret" } }), environment);
  const cookie = sessionCookieHeader(await signSession({ uid: 7, gh: "octocat" }, environment.ATLAS_SESSION_SECRET)).split(";")[0];
  const session = await authenticatedAccount(new Request(url, { headers: { cookie } }), environment);

  // All three of these share `dbUserId === null` — the whole point of keying on
  // the principal string instead.
  assert.equal(alice.dbUserId, null);
  assert.equal(bob.dbUserId, null);
  assert.equal(operator.dbUserId, null);
  const keys = [alice, bob, operator, session].map(taskOwnerKey);
  assert.deepEqual(keys, ["platform-alice", "platform-bob", "operator", "github:octocat"]);
  assert.equal(new Set(keys).size, 4);
});

test("shows a caller only their own task rows", async () => {
  const environment = { ATLAS_OPERATOR_TOKEN: "secret" };
  const url = "http://localhost/api/tasks";
  const alice = await authenticatedAccount(new Request(url, { headers: { "oai-authenticated-user-id": "platform-alice" } }), environment);
  const bob = await authenticatedAccount(new Request(url, { headers: { "oai-authenticated-user-id": "platform-bob" } }), environment);
  const operator = await authenticatedAccount(new Request(url, { headers: { authorization: "Bearer secret" } }), environment);

  const rows = [
    { taskId: "1", requestedBy: "platform-alice", objective: "Alice's private objective" },
    { taskId: "2", requestedBy: "platform-bob", objective: "Bob's private objective" },
    { taskId: "3", requestedBy: "operator", objective: "Operator objective" },
    { taskId: "4", requestedBy: "github:octocat", objective: "Session objective" },
  ];

  assert.deepEqual(visibleTasks(rows, alice).map((row) => row.taskId), ["1"]);
  assert.deepEqual(visibleTasks(rows, bob).map((row) => row.taskId), ["2"]);
  assert.deepEqual(visibleTasks(rows, operator).map((row) => row.taskId), ["3"]);
  assert.deepEqual(visibleTasks(rows, { userId: "github:octocat", dbUserId: 7 }).map((row) => row.taskId), ["4"]);
});

test("shows nothing at all to an unresolvable caller", () => {
  const rows = [{ taskId: "1", requestedBy: "platform-alice" }, { taskId: "2", requestedBy: null }];
  assert.deepEqual(visibleTasks(rows, null), []);
  assert.deepEqual(visibleTasks(rows, { userId: "", dbUserId: null }), []);
  assert.equal(taskOwnerKey(null), null);
  assert.equal(taskOwnerKey({ userId: 7 }), null);
});
