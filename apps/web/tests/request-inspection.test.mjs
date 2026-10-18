import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
import { migratedDatabase } from "./helpers/d1-sqlite.mjs";
import { inspectTaskRequest, listTaskRequests, decodeRequestCursor, REQUEST_PAGE_SIZE } from "../app/api/tasks/request-inspection.mjs";
import { readTaskRequests, requestExplanation } from "../app/build/request-inspection-client.mjs";
import { signSession } from "../app/api/auth/session.mjs";

const scope = { tenantId: 1, principal: "operator" };
const keyFor = n => `${n.toString(16).padStart(8, "0")}-1111-4111-8111-111111111111`;
const correlationFor = key => `cor_${key.replaceAll("-", "")}`;
function fixture(t) { const f = migratedDatabase({ users: [[99, "other"]] }); t.after(() => f.sqlite.close()); return f; }
function saveRequest(f, n, { owner = scope, state = "reserved", status = null, receipt = null } = {}) {
  const key = keyFor(n);
  f.sqlite.prepare("INSERT INTO task_requests (tenant_id, requested_by, request_key, fingerprint, correlation_id, state, response_status, response_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '2026-10-11 01:00:00')")
    .run(owner.tenantId, owner.principal, key, "a".repeat(64), correlationFor(key), state, status, receipt);
  return key;
}
function saveTask(f, n, { owner = scope, correlationId = correlationFor(keyFor(n)), state = "unknown", objective = "Inspect package.json" } = {}) {
  f.sqlite.prepare("INSERT INTO tasks (task_id, tenant_id, requested_by, repository, branch, mode, objective, correlation_id, dispatch_state, conversation_id) VALUES (?, ?, ?, 'owner/repo', 'main', 'inspect', ?, ?, ?, ?)")
    .run(keyFor(n), owner.tenantId, owner.principal, objective, correlationId, state, keyFor(n));
}

test("request history and detail require both tenant and principal ownership", async t => {
  const f = fixture(t);
  f.sqlite.exec("INSERT INTO tenants (id, slug, name, owner_principal) VALUES (2, 'other', 'Other', 'operator')");
  const own = saveRequest(f, 1);
  const foreignPrincipal = saveRequest(f, 2, { owner: { tenantId: 1, principal: "other" } });
  const foreignTenant = saveRequest(f, 3, { owner: { tenantId: 2, principal: "operator" } });
  assert.equal(await inspectTaskRequest(f.d1, scope, foreignPrincipal), null);
  assert.equal(await inspectTaskRequest(f.d1, scope, foreignTenant), null);
  assert.equal(await inspectTaskRequest(f.d1, { tenantId: 1, principal: "other" }, own), null);
  assert.deepEqual((await listTaskRequests(f.d1, scope)).requests.map(r => r.requestKey), [own]);
});

test("correlation recovery refuses foreign tasks and ambiguous matches", async t => {
  const f = fixture(t); const own = saveRequest(f, 1);
  f.sqlite.exec("INSERT INTO tenants (id, slug, name, owner_principal) VALUES (2, 'other', 'Other', 'operator')");
  saveTask(f, 2, { owner: { tenantId: 1, principal: "other" }, correlationId: correlationFor(own), objective: "private-principal-objective" });
  saveTask(f, 3, { owner: { tenantId: 2, principal: "operator" }, correlationId: correlationFor(own), objective: "private-tenant-objective" });
  const hidden = await inspectTaskRequest(f.d1, scope, own);
  assert.equal(hidden.task, null); assert.doesNotMatch(JSON.stringify(hidden), /private-/);
  saveTask(f, 4, { correlationId: correlationFor(own) });
  assert.equal((await inspectTaskRequest(f.d1, scope, own)).task.taskId, keyFor(4));
  saveTask(f, 5, { correlationId: correlationFor(own) });
  const ambiguous = await inspectTaskRequest(f.d1, scope, own);
  assert.equal(ambiguous.state, "ambiguous"); assert.equal(ambiguous.task, null);
});

test("inspection reports admission outcomes without claiming a task completed or echoing receipt bodies", async t => {
  const f = fixture(t);
  const reserved = saveRequest(f, 1);
  const accepted = saveRequest(f, 2, { state: "completed", status: 202, receipt: JSON.stringify({ taskId: "foreign-task", message: "private-provider-token" }) });
  const refused = saveRequest(f, 3, { state: "completed", status: 402, receipt: JSON.stringify({ message: "private-provider-token" }) });
  const failed = saveRequest(f, 4, { state: "completed", status: 503, receipt: "{corrupt private-provider-token" });
  const rejected = saveRequest(f, 5, { state: "completed", status: 502, receipt: JSON.stringify({ status: "dispatch-rejected" }) });
  f.sqlite.exec("UPDATE task_requests SET created_at = '2000-01-01 00:00:00'");
  const before = f.sqlite.prepare("SELECT * FROM task_requests ORDER BY request_key").all();
  for (const [key, state] of [[reserved, "unconfirmed"], [accepted, "acknowledged"], [refused, "refused"], [failed, "unconfirmed"], [rejected, "refused"]]) {
    const detail = await inspectTaskRequest(f.d1, scope, key);
    assert.equal(detail.state, state); assert.equal(detail.task, null);
    assert.doesNotMatch(JSON.stringify(detail), /private-provider-token|foreign-task|fingerprint|response_json/);
  }
  assert.deepEqual(f.sqlite.prepare("SELECT * FROM task_requests ORDER BY request_key").all(), before);
});

test("history has bounded, stable keyset pages even when every timestamp is equal", async t => {
  const f = fixture(t);
  for (let n = 1; n <= 45; n++) saveRequest(f, n);
  let page = await listTaskRequests(f.d1, scope); const keys = [];
  while (true) {
    assert.ok(page.requests.length <= REQUEST_PAGE_SIZE); keys.push(...page.requests.map(r => r.requestKey));
    if (!page.nextCursor) break;
    page = await listTaskRequests(f.d1, scope, decodeRequestCursor(page.nextCursor));
  }
  assert.equal(keys.length, 45); assert.equal(new Set(keys).size, 45);
  assert.equal(keys[0], keyFor(45)); assert.equal(keys.at(-1), keyFor(1));
  assert.equal(decodeRequestCursor(null), null);
  for (const invalid of ["", "not base64", "x".repeat(257), btoa(JSON.stringify({ key: keyFor(1), createdAt: "' OR 1=1" }))]) assert.throws(() => decodeRequestCursor(invalid));
});

test("task context is bounded and remains an observation of dispatch, not execution success", async t => {
  const f = fixture(t); const key = saveRequest(f, 1); saveTask(f, 1, { state: "dispatched", objective: "x".repeat(1000) });
  const detail = await inspectTaskRequest(f.d1, scope, key);
  assert.equal(detail.state, "task-saved"); assert.equal(detail.task.objective.length, 240);
  assert.match(requestExplanation(detail), /accepted.*check execution/);
  assert.doesNotMatch(requestExplanation(detail), /completed|succeeded/);
  assert.match(requestExplanation({ state: "unconfirmed" }), /may still be processing/);
});

test("browser status and pagination checks only issue uncached GET requests", async () => {
  const observed = [];
  const fetcher = async (url, options) => { observed.push({ url, options }); return Response.json({ requests: [], nextCursor: null }); };
  await readTaskRequests({ fetcher });
  await readTaskRequests({ cursor: "a+b/=", fetcher });
  await readTaskRequests({ requestKey: keyFor(1), fetcher });
  assert.equal(observed[1].url, "/api/tasks/requests?cursor=a%2Bb%2F%3D");
  assert.equal(observed[2].url, `/api/tasks/requests/${keyFor(1)}`);
  for (const { options } of observed) { assert.equal(options.method, "GET"); assert.equal(options.cache, "no-store"); assert.equal(options.body, undefined); }
  await assert.rejects(readTaskRequests({ requestKey: "invalid", fetcher: () => assert.fail("invalid identity must not reach the network") }));
  await assert.rejects(readTaskRequests({ fetcher: async () => new Response("private server text", { status: 503 }) }), /Saved requests are unavailable/);
});

test("missing request storage is unavailable, not empty successful history", async t => {
  const f = fixture(t); f.sqlite.exec("DROP TABLE task_requests");
  await assert.rejects(listTaskRequests(f.d1, scope));
  await assert.rejects(inspectTaskRequest(f.d1, scope, keyFor(1)));
});

test("built Worker inspects lost-response requests after reconnect without dispatch or billing side effects", async t => {
  const f = fixture(t);
  for (let n = 1; n <= 22; n++) saveRequest(f, n);
  saveTask(f, 1);
  saveRequest(f, 99, { owner: { tenantId: 1, principal: "github:other" } });
  f.sqlite.prepare("INSERT INTO tenant_members (tenant_id, user_id, role) VALUES (1, 99, 'member')").run();
  register(`data:text/javascript,${encodeURIComponent(`export async function resolve(specifier, context, next) {
    if (specifier === "cloudflare:workers") return { url: "data:text/javascript,export const env = globalThis.__inspectionEnv; export class DurableObject {}", shortCircuit: true };
    return next(specifier, context);
  }`)}`, import.meta.url);
  const wrap = statement => ({ ...statement, bind: (...values) => wrap(statement.bind(...values)), raw: async () => (await statement.all()).results.map(row => Object.values(row)) });
  globalThis.__inspectionEnv = { DB: { ...f.d1, prepare: sql => wrap(f.d1.prepare(sql)) } };
  const configuration = { ATLAS_OPERATOR_TOKEN: "operator-test", ATLAS_GITHUB_TOKEN: "github-test", ATLAS_SESSION_SECRET: "test-session-secret" };
  const previous = Object.fromEntries(Object.keys(configuration).map(k => [k, process.env[k]]));
  const originalFetch = globalThis.fetch; Object.assign(process.env, configuration);
  let externalCalls = 0;
  globalThis.fetch = () => { externalCalls++; assert.fail("inspection must not call a model or executor"); };
  t.after(() => {
    globalThis.fetch = originalFetch; delete globalThis.__inspectionEnv;
    for (const [k, value] of Object.entries(previous)) { if (value === undefined) delete process.env[k]; else process.env[k] = value; }
  });
  const { default: worker } = await import(new URL("../dist/server/index.js", import.meta.url));
  const invoke = request => worker.fetch(request, globalThis.__inspectionEnv, { waitUntil() {}, passThroughOnException() {} });
  const get = (path = "", headers = {}) => new Request(`https://atlas.test/api/tasks/requests${path}`, { headers: { authorization: "Bearer operator-test", ...headers } });
  const snapshots = ["task_requests", "tasks", "task_usage"].map(table => f.sqlite.prepare(`SELECT * FROM ${table} ORDER BY 1`).all());
  const listed = await invoke(get()); assert.equal(listed.status, 200); assert.equal(listed.headers.get("cache-control"), "no-store");
  const page = await listed.json(); assert.equal(page.requests.length, 20); assert.ok(page.nextCursor);
  const older = await invoke(get(`?cursor=${encodeURIComponent(page.nextCursor)}`)); assert.equal((await older.json()).requests.length, 2);
  const detail = await invoke(get(`/${keyFor(1)}`)); assert.equal(detail.status, 200);
  const saved = (await detail.json()).request; assert.equal(saved.task.taskId, keyFor(1)); assert.equal(saved.task.dispatchState, "unknown");
  const uncertain = await invoke(get(`/${keyFor(2)}`)); assert.equal((await uncertain.json()).request.state, "unconfirmed");
  const session = await signSession({ uid: 99, gh: "other" }, configuration.ATLAS_SESSION_SECRET);
  const otherHeaders = { authorization: "", cookie: `atlas_session=${session}` };
  const hidden = await invoke(get(`/${keyFor(1)}`, otherHeaders)); assert.equal(hidden.status, 404);
  const missing = await invoke(get(`/${keyFor(1000)}`, otherHeaders)); assert.equal(missing.status, 404); assert.deepEqual(await hidden.json(), await missing.json());
  const otherList = await invoke(get("", otherHeaders)); assert.deepEqual((await otherList.json()).requests.map(r => r.requestKey), [keyFor(99)]);
  assert.equal((await invoke(get("", { authorization: "Bearer wrong" }))).status, 401);
  assert.equal((await invoke(get("", { ...otherHeaders, "x-atlas-tenant": "999" }))).status, 403);
  assert.equal((await invoke(get("?cursor=invalid"))).status, 400);
  assert.equal((await invoke(get("/invalid"))).status, 404);
  const mutation = await invoke(new Request(`https://atlas.test/api/tasks/requests/${keyFor(1)}`, {
    method: "POST", headers: { authorization: "Bearer operator-test", "content-type": "application/json" }, body: JSON.stringify({ action: "retry" }),
  }));
  assert.equal(mutation.status, 405);
  assert.equal(externalCalls, 0);
  for (const [index, table] of ["task_requests", "tasks", "task_usage"].entries()) assert.deepEqual(f.sqlite.prepare(`SELECT * FROM ${table} ORDER BY 1`).all(), snapshots[index]);
  f.sqlite.exec("DROP TABLE task_requests");
  const unavailable = await invoke(get()); assert.equal(unavailable.status, 503); assert.doesNotMatch(await unavailable.text(), /SQL|no such table|github-test/);
});
