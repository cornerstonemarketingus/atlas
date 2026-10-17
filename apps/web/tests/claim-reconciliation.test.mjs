import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { migratedDatabase } from "./helpers/d1-sqlite.mjs";
import { dispatchSavedTask } from "../app/api/tasks/durable-dispatch.mjs";
import { grantTaskExecution } from "../app/api/tasks/execution-claims.mjs";
import { saveRunnerResult } from "../app/api/tasks/result-storage.mjs";
import { reconcileSavedRequest, verifySavedExecution } from "../app/api/tasks/claim-reconciliation.mjs";
import { reconcileTaskRequest } from "../app/build/request-inspection-client.mjs";
import { signSession } from "../app/api/auth/session.mjs";
const taskId = "11111111-1111-4111-8111-111111111111";
const identity = { run_id: "123", run_attempt: "1" };
const scope = { tenantId: 1, principal: "operator" };
const outcome = { runId: 123, runAttempt: 1, jobId: 456, headSha: "a".repeat(40), conclusion: "cancelled", completedAt: "2026-10-15T00:00:00.000Z" };
const run = { id: 123, run_attempt: 1, repository: { id: 1337761549, full_name: "cornerstonemarketingus/atlas" }, event: "workflow_dispatch", head_branch: "main", head_sha: outcome.headSha, path: ".github/workflows/atlas-coder.yml", display_title: `Atlas Coder · task ${taskId}` };
async function fixture(t) {
  const f = migratedDatabase({ users: [[99, "other"]] }); t.after(() => f.sqlite.close());
  const task = { taskId, tenantId: 1, requestedBy: "operator", repository: "cornerstonemarketingus/atlas", branch: "feature", mode: "coder", objective: "Fix tests", mergePolicy: "manual", correlationId: `cor_${"a".repeat(32)}`, conversationId: "conversation", executionProvider: "managed", dispatchState: "dispatched", githubRunId: null };
  await dispatchSavedTask(f.d1, { ...task, account: { userId: "operator", dbUserId: null }, task }, async () => new Response(null, { status: 204 }));
  f.sqlite.prepare("INSERT INTO task_requests (tenant_id, requested_by, request_key, fingerprint, correlation_id, state) VALUES (1, 'operator', ?, ?, ?, 'reserved')").run(taskId, "a".repeat(64), task.correlationId);
  await grantTaskExecution(f.d1, task, identity, new Date("2026-01-01T00:00:00Z"));
  return { ...f, task };
}
const n = (f, table) => f.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;

test("reconciliation verifies only exact saved attempt metadata and immutable repository", async () => {
  const task = { taskId, repository: run.repository.full_name, mode: "coder", executionProvider: "managed", githubRunId: 123 };
  const calls = [];
  const fetcher = async (url, options) => {
    calls.push(String(url)); assert.equal(options.redirect, "error"); assert.equal(options.headers.authorization, "Bearer fake-github"); assert.ok(options.signal);
    return String(url).includes("/jobs?") ? Response.json({ total_count: 1, jobs: [{ id: 456, name: "run", run_id: 123, run_attempt: 1, head_sha: outcome.headSha, head_branch: "main", workflow_name: "Atlas Coder", status: "completed", conclusion: "cancelled", completed_at: outcome.completedAt }] }) : Response.json(run);
  };
  assert.deepEqual((await verifySavedExecution(task, { runId: 123, runAttempt: 1 }, "fake-github", fetcher)).outcome, outcome);
  assert.equal(calls[0], "https://api.github.com/repos/cornerstonemarketingus/atlas/actions/runs/123/attempts/1");
  assert.match(calls[1], /\/attempts\/1\/jobs\?per_page=100$/);
  for (const changes of [{ id: 124 }, { run_attempt: 2 }, { event: "pull_request" }, { head_branch: "feature" }, { path: ".github/workflows/ci.yml" }, { display_title: "other task" }, { repository: { id: 999, full_name: task.repository } }, { repository: { id: 1337761549, full_name: "foreign/repo" } }]) await assert.rejects(verifySavedExecution(task, { runId: 123, runAttempt: 1 }, "fake-github", async (url, options) => String(url).includes("/jobs?") ? fetcher(url, options) : Response.json({ ...run, ...changes })));
  await assert.rejects(verifySavedExecution({ ...task, repository: "foreign/repo" }, { runId: 123, runAttempt: 1 }, "fake-github", () => assert.fail("No unsupported repository calls")));
});

test("reconciliation records no synthetic report and leaves claims and billing unchanged; late reporting still works", async t => {
  const f = await fixture(t); let calls = 0;
  const claim = f.sqlite.prepare("SELECT * FROM task_execution_claims").get();
  const verify = async (task, savedClaim) => { calls++; assert.equal(task.taskId, taskId); assert.deepEqual(savedClaim, { runId: 123, runAttempt: 1 }); return { identity, outcome }; };
  const first = await reconcileSavedRequest(f.d1, scope, taskId, verify);
  assert.equal(first.status, "observed"); assert.equal(first.cached, false); assert.equal(first.request.task.execution.outcome.conclusion, "cancelled");
  assert.equal(n(f, "conversation_messages"), 1); // original objective only
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM run_events WHERE kind = 'result'").get().n, 0);
  const second = await reconcileSavedRequest(f.d1, scope, taskId, verify); assert.equal(second.cached, true); assert.equal(calls, 1);
  assert.deepEqual(f.sqlite.prepare("SELECT * FROM task_execution_claims").get(), claim); assert.equal(n(f, "task_usage"), 0);
  assert.equal(await saveRunnerResult(f.d1, f.task, identity, "Actual delayed agent report", new Date().toISOString(), outcome), true);
  assert.equal(f.sqlite.prepare("SELECT content FROM conversation_messages WHERE id LIKE 'result:%'").get().content, "Actual delayed agent report");
  assert.equal(n(f, "task_execution_outcomes"), 1); assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM run_events WHERE kind = 'execution-outcome'").get().n, 1);
});

test("foreign, unclaimed and ambiguous requests do not invoke GitHub verification", async t => {
  const f = await fixture(t); const verify = () => assert.fail("No external calls for ineligible ownership");
  assert.equal((await reconcileSavedRequest(f.d1, { ...scope, principal: "foreign" }, taskId, verify)).status, "not-found");
  assert.equal((await reconcileSavedRequest(f.d1, { ...scope, tenantId: 2 }, taskId, verify)).status, "not-found");
  f.sqlite.exec("UPDATE task_execution_claims SET requested_by = 'foreign'");
  assert.equal((await reconcileSavedRequest(f.d1, scope, taskId, verify)).status, "not-eligible");
  f.sqlite.exec("UPDATE task_execution_claims SET requested_by = 'operator'");
  f.sqlite.prepare("INSERT INTO tasks (task_id, tenant_id, requested_by, repository, branch, mode, objective, correlation_id) VALUES ('22222222-2222-4222-8222-222222222222', 1, 'operator', 'cornerstonemarketingus/atlas', 'main', 'coder', 'Duplicate', ?)").run(f.task.correlationId);
  assert.equal((await reconcileSavedRequest(f.d1, scope, taskId, verify)).status, "not-eligible");
  assert.equal(n(f, "task_execution_outcomes"), 0);
});

test("ownership changes during verification and audit failures leave no partial outcome", async t => {
  const f = await fixture(t);
  const raced = await reconcileSavedRequest(f.d1, scope, taskId, async () => { f.sqlite.exec("UPDATE tasks SET objective = 'changed during verification'"); return { identity, outcome }; });
  assert.equal(raced.status, "conflict"); assert.equal(n(f, "task_execution_outcomes"), 0);
  f.sqlite.prepare("UPDATE tasks SET objective = ?").run(f.task.objective);
  f.sqlite.exec("CREATE TRIGGER fail_reconcile BEFORE INSERT ON run_events WHEN NEW.kind = 'execution-outcome' BEGIN SELECT RAISE(ABORT, 'private failure'); END");
  await assert.rejects(reconcileSavedRequest(f.d1, scope, taskId, async () => ({ identity, outcome })));
  assert.equal(n(f, "task_execution_outcomes"), 0);
});

test("mobile reconciliation sends only opaque request identity and an empty same-origin JSON intent", async () => {
  const response = await reconcileTaskRequest({ requestKey: taskId, fetcher: async (url, options) => {
    assert.equal(url, `/api/tasks/requests/${taskId}/reconcile`); assert.equal(options.method, "POST"); assert.equal(options.body, "{}"); assert.equal(options.cache, "no-store"); assert.ok(options.signal); return Response.json({ reconciled: true });
  } });
  assert.equal(response.reconciled, true);
  await assert.rejects(reconcileTaskRequest({ requestKey: "bad", fetcher: () => assert.fail("No request") }));
  await assert.rejects(reconcileTaskRequest({ requestKey: taskId, fetcher: async () => new Response("private", { status: 503 }) }), /No task was started/);
});

test("built Worker enforces authentication, same-origin intent and scoped exact-attempt reconciliation", async t => {
  const f = await fixture(t);
  register(`data:text/javascript,${encodeURIComponent(`export async function resolve(specifier, context, next) {
    if (specifier === "cloudflare:workers") return { url: "data:text/javascript,export const env = globalThis.__reconcileEnv; export class DurableObject {}", shortCircuit: true };
    return next(specifier, context);
  }`)}`, import.meta.url);
  f.sqlite.prepare("INSERT INTO tenant_members (tenant_id, user_id, role) VALUES (1, 99, 'member')").run();
  const wrap = statement => ({ ...statement, bind: (...values) => wrap(statement.bind(...values)), raw: async () => (await statement.all()).results.map(row => Object.values(row)) });
  globalThis.__reconcileEnv = { DB: { ...f.d1, prepare: sql => wrap(f.d1.prepare(sql)) } };
  const configuration = { ATLAS_OPERATOR_TOKEN: "operator-reconcile", ATLAS_GITHUB_TOKEN: "github-reconcile", ATLAS_SESSION_SECRET: "reconcile-test-session-secret-32-characters" };
  const previous = Object.fromEntries(Object.keys(configuration).map(key => [key, process.env[key]])); Object.assign(process.env, configuration);
  const originalFetch = globalThis.fetch; let jobStatus = "in_progress"; let calls = 0; let liveRun = run;
  globalThis.fetch = async (url, options) => {
    calls++; assert.equal(options.redirect, "error"); assert.equal(options.headers.authorization, "Bearer github-reconcile");
    assert.match(String(url), /^https:\/\/api.github.com\/repos\/cornerstonemarketingus\/atlas\/actions\/runs\/123\/attempts\/1/);
    return String(url).includes("/jobs?") ? Response.json({ total_count: 1, jobs: [{ id: 456, name: "run", run_id: 123, run_attempt: 1, head_sha: outcome.headSha, head_branch: "main", workflow_name: "Atlas Coder", status: jobStatus, conclusion: "cancelled", completed_at: outcome.completedAt }] }) : Response.json(liveRun);
  };
  t.after(() => { globalThis.fetch = originalFetch; delete globalThis.__reconcileEnv; for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const { default: worker } = await import(new URL("../dist/server/index.js", import.meta.url));
  const endpoint = `https://atlas.test/api/tasks/requests/${taskId}/reconcile`;
  const invoke = (headers = {}, body = "{}", url = endpoint) => worker.fetch(new Request(url, { method: "POST", headers: { authorization: "Bearer operator-reconcile", "content-type": "application/json", ...headers }, body }), globalThis.__reconcileEnv, { waitUntil() {}, passThroughOnException() {} });
  assert.equal((await invoke({ authorization: "Bearer wrong" })).status, 401);
  assert.equal((await invoke({ origin: "https://foreign.test" })).status, 403);
  assert.equal((await invoke({ "sec-fetch-site": "cross-site" })).status, 403);
  assert.equal((await invoke({}, '{"runId":999}')).status, 400);
  assert.equal((await invoke({}, "x".repeat(300))).status, 400);
  assert.equal((await invoke({ "content-type": "text/plain" })).status, 400);
  const session = await signSession({ uid: 99, gh: "other" }, configuration.ATLAS_SESSION_SECRET);
  const foreign = { authorization: "", cookie: `atlas_session=${session}` };
  assert.equal((await invoke(foreign)).status, 404);
  assert.equal((await invoke({ ...foreign, "x-atlas-tenant": "999" })).status, 403);
  assert.equal(calls, 0);
  assert.equal((await invoke()).status, 503); assert.equal(n(f, "task_execution_outcomes"), 0);
  jobStatus = "completed"; liveRun = { ...run, repository: { ...run.repository, id: 999 } };
  assert.equal((await invoke()).status, 503); liveRun = run;
  const response = await invoke({ origin: "https://atlas.test" }); assert.equal(response.status, 200, await response.clone().text()); assert.equal(response.headers.get("cache-control"), "no-store");
  const view = await response.json(); assert.equal(view.request.task.execution.outcome.conclusion, "cancelled"); assert.equal(view.cached, false);
  const before = calls; assert.equal((await (await invoke()).json()).cached, true); assert.equal(calls, before);
  assert.equal(n(f, "task_usage"), 0); assert.equal(n(f, "task_execution_claims"), 1);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM conversation_messages WHERE id LIKE 'result:%'").get().n, 0);
  f.sqlite.exec("DROP TABLE task_execution_outcomes");
  const unavailable = await invoke(); assert.equal(unavailable.status, 503); assert.doesNotMatch(await unavailable.text(), /SQL|no such table|github-reconcile/);
});
