import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
import { migratedDatabase } from "./helpers/d1-sqlite.mjs";
import { dispatchSavedTask, persistTaskIntent, reconcileDispatchRuns, savedDispatchStatus, saveReconciledDispatch } from "../app/api/tasks/durable-dispatch.mjs";
import { taskStorageReadiness } from "../app/api/tasks/storage-readiness.mjs";
import { signSession } from "../app/api/auth/session.mjs";
import { currentPeriodStart } from "../app/api/billing/period.mjs";
import { dispatchGitHub } from "../app/api/tasks/dispatch.mjs";

const taskId = "11111111-1111-4111-8111-111111111111";
function fixture(t) {
  const { sqlite, d1 } = migratedDatabase({ users: [[99, "other"]] });
  t.after(() => sqlite.close());
  const data = { taskId, tenantId: 1, account: { userId: "operator", dbUserId: null }, task: { repository: "owner/repo", branch: "feature", mode: "coder", objective: "Fix the tests in package.json" }, conversationId: "conversation", mergePolicy: "manual", executionProvider: "managed", correlationId: `cor_${"a".repeat(32)}` };
  return { sqlite, d1, data };
}

test("task, conversation, request and audit are atomically visible before the external dispatch", async t => {
  const f = fixture(t); let calls = 0;
  const outcome = await dispatchSavedTask(f.d1, f.data, async () => {
    calls++;
    assert.equal(f.sqlite.prepare("SELECT dispatch_state FROM tasks").get().dispatch_state, "dispatching");
    assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM conversations").get().n, 1);
    assert.equal(f.sqlite.prepare("SELECT content FROM conversation_messages").get().content, f.data.task.objective);
    assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM run_events").get().n, 2);
    return new Response(null, { status: 204 });
  });
  assert.equal(outcome.state, "dispatched"); assert.equal(calls, 1);
  assert.equal(f.sqlite.prepare("SELECT dispatch_state FROM tasks").get().dispatch_state, "dispatched");
});

test("mid-transaction storage failure rolls everything back and prevents dispatch", async t => {
  const f = fixture(t);
  f.sqlite.exec("CREATE TRIGGER fail_audit BEFORE INSERT ON run_events BEGIN SELECT RAISE(ABORT, 'private database diagnostic'); END;");
  await assert.rejects(dispatchSavedTask(f.d1, f.data, () => assert.fail("must not dispatch")));
  for (const table of ["tasks", "conversations", "conversation_messages", "run_events"]) assert.equal(f.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0);
});

test("a conversation owned by another principal or tenant cannot receive task intent", async t => {
  const f = fixture(t);
  f.sqlite.prepare("INSERT INTO conversations (id, tenant_id, requested_by, title, repository, branch) VALUES ('conversation', 1, 'other', 'private', 'private/repo', 'main')").run();
  await assert.rejects(dispatchSavedTask(f.d1, f.data, () => assert.fail("must not dispatch")));
  assert.equal(f.sqlite.prepare("SELECT repository FROM conversations").get().repository, "private/repo");
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM tasks").get().n, 0);
  f.sqlite.prepare("INSERT INTO tenants (id, slug, name, owner_principal) VALUES (2, 'other', 'Other', 'other')").run();
  f.sqlite.prepare("UPDATE conversations SET requested_by = 'operator', tenant_id = 2").run();
  await assert.rejects(persistTaskIntent(f.d1, f.data));
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM conversation_messages").get().n, 0);
});

test("lost acknowledgement persists an uncertain task without retry or duplicate work", async t => {
  const f = fixture(t); let calls = 0;
  const send = async () => { calls++; throw new Error("private provider detail"); };
  assert.equal((await dispatchSavedTask(f.d1, f.data, send)).state, "unknown");
  assert.equal(f.sqlite.prepare("SELECT dispatch_state FROM tasks").get().dispatch_state, "unknown");
  await assert.rejects(dispatchSavedTask(f.d1, f.data, send));
  assert.equal(calls, 1);
  assert.doesNotMatch(JSON.stringify(f.sqlite.prepare("SELECT detail FROM run_events").all()), /private provider detail/);
});

test("a cancellation-ignoring dispatch is bounded and remains saved as uncertain", { timeout: 5000 }, async t => {
  const f = fixture(t); let calls = 0; let signal;
  const outcome = await dispatchSavedTask(f.d1, f.data, () => dispatchGitHub({
    token: "fixture-token", workflow: "atlas-coder.yml", task: f.data.task, taskId,
  }, (_url, init) => { calls++; signal = init.signal; return new Promise(() => {}); }, { timeoutMs: 20 }));
  assert.equal(outcome.state, "unknown");
  assert.equal(calls, 1);
  assert.equal(signal.aborted, true);
  assert.equal(f.sqlite.prepare("SELECT dispatch_state FROM tasks").get().dispatch_state, "unknown");
  await assert.rejects(dispatchSavedTask(f.d1, f.data, () => assert.fail("uncertain work must not dispatch again")));
});

test("a response arriving after the dispatch deadline is discarded without replay", { timeout: 5000 }, async t => {
  const f = fixture(t); let finish; let cancelled = false; let calls = 0;
  const outcome = await dispatchSavedTask(f.d1, f.data, () => dispatchGitHub({
    token: "fixture-token", workflow: "atlas-coder.yml", task: f.data.task, taskId,
  }, () => { calls++; return new Promise(resolve => { finish = resolve; }); }, { timeoutMs: 20 }));
  assert.equal(outcome.state, "unknown");
  finish(new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status: 200 }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(cancelled, true);
  assert.equal(calls, 1);
  assert.equal(f.sqlite.prepare("SELECT dispatch_state FROM tasks").get().dispatch_state, "unknown");
});

test("server failures are uncertain; explicit refusals are rejected, with no implicit retry", async t => {
  for (const [status, expected] of [[500, "unknown"], [503, "unknown"], [401, "rejected"], [403, "rejected"], [404, "rejected"], [422, "rejected"]]) {
    const f = fixture(t); let calls = 0;
    const result = await dispatchSavedTask(f.d1, f.data, async () => { calls++; return new Response("private provider text", { status }); });
    assert.equal(result.state, expected); assert.equal(calls, 1);
    assert.equal(f.sqlite.prepare("SELECT dispatch_state FROM tasks").get().dispatch_state, expected);
    assert.doesNotMatch(JSON.stringify(f.sqlite.prepare("SELECT detail FROM run_events").all()), /private provider text/);
  }
});

test("failure to save dispatching blocks the action; failure to save acceptance retains intent", async t => {
  const f = fixture(t);
  f.sqlite.exec("CREATE TRIGGER fail_begin BEFORE UPDATE OF dispatch_state ON tasks WHEN NEW.dispatch_state = 'dispatching' BEGIN SELECT RAISE(ABORT, 'blocked'); END;");
  await assert.rejects(dispatchSavedTask(f.d1, f.data, () => assert.fail("must not dispatch")));
  assert.equal(f.sqlite.prepare("SELECT dispatch_state FROM tasks").get().dispatch_state, "recorded");
  const other = fixture(t);
  other.sqlite.exec("CREATE TRIGGER fail_accept BEFORE UPDATE OF dispatch_state ON tasks WHEN NEW.dispatch_state = 'dispatched' BEGIN SELECT RAISE(ABORT, 'blocked'); END;");
  assert.equal((await dispatchSavedTask(other.d1, other.data, async () => new Response(null, { status: 204 }))).state, "dispatched");
  assert.equal(other.sqlite.prepare("SELECT dispatch_state FROM tasks").get().dispatch_state, "dispatching");
});

test("reconciliation needs one exact task/repository/workflow/event/branch, never proximity in time", () => {
  const row = { taskId, repository: "owner/repo", githubRunId: null, dispatchState: "unknown" };
  const run = { id: 123, display_title: `Atlas Coder · task ${taskId}`, name: "Atlas Coder", repository: { full_name: "owner/repo" }, event: "workflow_dispatch", head_branch: "main", path: ".github/workflows/atlas-coder.yml" };
  assert.deepEqual(reconcileDispatchRuns([row], [run], "atlas-coder.yml"), [{ taskId, runId: 123 }]);
  for (const changes of [{ display_title: "Manual run" }, { repository: { full_name: "other/repo" } }, { path: ".github/workflows/other.yml" }, { event: "push" }, { head_branch: "feature" }]) assert.deepEqual(reconcileDispatchRuns([row], [{ ...run, ...changes }], "atlas-coder.yml"), []);
  assert.deepEqual(reconcileDispatchRuns([row], [run, { ...run, id: 124 }], "atlas-coder.yml"), []);
  for (const dispatchState of ["legacy", "recorded", "rejected"]) assert.deepEqual(reconcileDispatchRuns([{ ...row, dispatchState }], [run], "atlas-coder.yml"), []);
  assert.equal(savedDispatchStatus(row, null), "dispatch-unknown");
  assert.equal(savedDispatchStatus({ ...row, dispatchState: "recorded" }, null), "dispatch-pending");
  assert.equal(savedDispatchStatus({ ...row, dispatchState: "rejected" }, null), "failed");
  assert.equal(savedDispatchStatus({ ...row, dispatchState: "legacy" }, null), null);
});

test("missing intent migration fails readiness before dispatch; legacy rows retain their behavior", async t => {
  const f = fixture(t);
  assert.equal((await taskStorageReadiness(f.d1)).ready, true);
  f.sqlite.prepare("INSERT INTO tasks (task_id, requested_by, repository, branch, mode, objective) VALUES ('old', 'operator', 'owner/repo', 'main', 'inspect', 'inspect')").run();
  assert.equal(f.sqlite.prepare("SELECT dispatch_state FROM tasks").get().dispatch_state, "legacy");
  f.sqlite.exec("ALTER TABLE tasks DROP COLUMN dispatch_state");
  const readiness = await taskStorageReadiness(f.d1); assert.equal(readiness.ready, false);
  assert.deepEqual(readiness.missing, ["tasks.dispatch_state"]);
});

test("reconciliation receipts are tenant-scoped, stable and cannot replace an existing run", async t => {
  const f = fixture(t);
  await dispatchSavedTask(f.d1, f.data, async () => { throw new Error("lost acknowledgement"); });
  const match = { taskId, runId: 123, tenantId: 1, principal: "operator" };
  await assert.rejects(saveReconciledDispatch(f.d1, { ...match, tenantId: 2 }));
  await assert.rejects(saveReconciledDispatch(f.d1, { ...match, principal: "other" }));
  assert.equal(f.sqlite.prepare("SELECT dispatch_state FROM tasks").get().dispatch_state, "unknown");
  await saveReconciledDispatch(f.d1, match);
  await saveReconciledDispatch(f.d1, match);
  assert.equal(f.sqlite.prepare("SELECT dispatch_state FROM tasks").get().dispatch_state, "dispatched");
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM run_events WHERE id = ?").get(`dispatch:${taskId}:reconciled`).n, 1);
  await assert.rejects(saveReconciledDispatch(f.d1, { ...match, runId: 124 }));
});

test("built Worker saves before dispatch, survives lost response, reconciles after reconnect, and refuses unauthorized/budget-exhausted work", async t => {
  const f = fixture(t);
  register(`data:text/javascript,${encodeURIComponent(`export async function resolve(specifier, context, next) {
    if (specifier === "cloudflare:workers") return { url: "data:text/javascript,export const env = globalThis.__durableDispatchEnv; export class DurableObject {}", shortCircuit: true };
    return next(specifier, context);
  }`)}`, import.meta.url);
  const wrap = statement => ({ ...statement, bind: (...values) => wrap(statement.bind(...values)), raw: async () => (await statement.all()).results.map(row => Object.values(row)) });
  globalThis.__durableDispatchEnv = { DB: { ...f.d1, prepare: sql => wrap(f.d1.prepare(sql)) } };
  const configuration = { ATLAS_OPERATOR_TOKEN: "operator-test", ATLAS_GITHUB_TOKEN: "github-test", ATLAS_ALLOWED_REPOSITORIES: "owner/repo", ATLAS_SESSION_SECRET: "test-session-secret" };
  const previous = Object.fromEntries(Object.keys(configuration).map(key => [key, process.env[key]]));
  const originalFetch = globalThis.fetch; Object.assign(process.env, configuration);
  let dispatches = 0; let dispatchedId; let dispatchObserved = false;
  globalThis.fetch = async (url, options) => {
    if (String(url).includes("/collaborators/")) return Response.json({ role_name: "write" });
    if (options.method === "POST") {
      dispatches++; const inputs = JSON.parse(options.body).inputs; dispatchedId = inputs.task_id;
      assert.equal(options.redirect, "error"); assert.equal(options.headers.authorization, "Bearer github-test");
      assert.equal(f.sqlite.prepare("SELECT dispatch_state FROM tasks WHERE task_id = ?").get(dispatchedId).dispatch_state, "dispatching");
      assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM conversation_messages WHERE id = ?").get(`request:${dispatchedId}`).n, 1);
      dispatchObserved = true;
      throw new TypeError("private provider connection error");
    }
    return Response.json({ workflow_runs: [{ id: 123, display_title: `Atlas Coder · task ${dispatchedId}`, name: "Atlas Coder", repository: { full_name: "owner/repo" }, event: "workflow_dispatch", head_branch: "main", path: ".github/workflows/atlas-coder.yml", created_at: new Date().toISOString(), status: "in_progress" }] });
  };
  t.after(() => {
    globalThis.fetch = originalFetch; delete globalThis.__durableDispatchEnv;
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  });
  const { default: worker } = await import(new URL("../dist/server/index.js", import.meta.url));
  const invoke = request => worker.fetch(request, globalThis.__durableDispatchEnv, { waitUntil() {}, passThroughOnException() {} });
  const post = headers => new Request("https://atlas.test/api/tasks", { method: "POST", headers: { authorization: "Bearer operator-test", "content-type": "application/json", ...headers }, body: JSON.stringify(f.data.task) });
  assert.equal((await invoke(post({ authorization: "Bearer wrong" }))).status, 401);
  const response = await invoke(post()); assert.equal(response.status, 202);
  const body = await response.json(); assert.equal(body.status, "dispatch-unknown"); assert.equal(body.recorded, true); assert.equal(body.taskId, dispatchedId);
  assert.equal(dispatchObserved, true, "all pre-dispatch assertions must pass before the intentional transport failure");
  assert.doesNotMatch(JSON.stringify(body), /private provider|github-test|Nothing was started/);
  const listed = await invoke(new Request("https://atlas.test/api/tasks", { headers: { authorization: "Bearer operator-test" } }));
  const tasks = (await listed.json()).tasks; assert.equal(tasks.length, 1); assert.equal(tasks[0].taskId, dispatchedId); assert.equal(tasks[0].run.id, 123); assert.equal(tasks[0].status, "running");
  assert.equal(f.sqlite.prepare("SELECT github_run_id FROM tasks").get().github_run_id, 123); assert.equal(dispatches, 1);
  assert.equal(f.sqlite.prepare("SELECT dispatch_state FROM tasks").get().dispatch_state, "dispatched");
  f.sqlite.prepare("INSERT INTO tasks (task_id, tenant_id, requested_by, repository, branch, mode, objective, created_at) VALUES ('legacy-task', 1, 'operator', 'owner/repo', 'main', 'coder', 'Old request', ?)").run(new Date().toISOString());
  const refreshed = await invoke(new Request("https://atlas.test/api/tasks", { headers: { authorization: "Bearer operator-test" } }));
  assert.equal((await refreshed.json()).tasks.find(task => task.taskId === "legacy-task").run, null);
  const session = await signSession({ uid: 99, gh: "other" }, configuration.ATLAS_SESSION_SECRET);
  const otherHeaders = { cookie: `atlas_session=${session}` };
  const hidden = await invoke(new Request("https://atlas.test/api/tasks", { headers: otherHeaders }));
  assert.equal(hidden.status, 200); assert.deepEqual((await hidden.json()).tasks, []);
  f.sqlite.prepare("INSERT INTO repositories (tenant_id, owner, name) SELECT id, 'owner', 'repo' FROM tenants WHERE personal_user_id = 99").run();
  f.sqlite.prepare("INSERT INTO task_usage (user_id, period_start, task_count) VALUES (?, ?, ?)").run(99, currentPeriodStart(new Date()), 1000000);
  const denied = await invoke(new Request("https://atlas.test/api/tasks", { method: "POST", headers: { ...otherHeaders, "content-type": "application/json" }, body: JSON.stringify({ ...f.data.task, mode: "inspect" }) }));
  assert.equal(denied.status, 402, JSON.stringify(await denied.json())); assert.equal(dispatches, 1); assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM tasks").get().n, 2);
  f.sqlite.exec("CREATE TRIGGER reject_saved_request BEFORE INSERT ON run_events WHEN NEW.kind = 'queued' BEGIN SELECT RAISE(ABORT, 'storage failure'); END");
  const unavailable = await invoke(post());
  assert.equal(unavailable.status, 503); assert.equal(dispatches, 1);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM tasks").get().n, 2);
});
