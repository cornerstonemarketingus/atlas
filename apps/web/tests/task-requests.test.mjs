import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
import { migratedDatabase } from "./helpers/d1-sqlite.mjs";
import { executeTaskRequest } from "../app/api/tasks/task-requests.mjs";
import { taskRequestFingerprint } from "../app/api/tasks/task-request-contract.mjs";
import { dispatchSavedTask } from "../app/api/tasks/durable-dispatch.mjs";
import { submitTaskRequest, PENDING_REQUEST_STORAGE } from "../app/build/task-request-client.mjs";
import { signSession } from "../app/api/auth/session.mjs";

const key = "11111111-1111-4111-8111-111111111111";
const scope = { tenantId: 1, principal: "operator" };
const payload = { repository: "owner/repo", branch: "main", mode: "inspect", objective: "Inspect the package.json dependencies", conversationId: null };
const admission = { key, fingerprint: "a".repeat(64) };
function fixture(t) { const f = migratedDatabase({ users: [[99, "other"]] }); t.after(() => f.sqlite.close()); return f; }
function storage() { const values = new Map(); return { getItem: k => values.get(k) ?? null, setItem: (k, v) => values.set(k, v) }; }

test("concurrent identical requests enter dispatch and billing once, then replay the original response", async t => {
  const f = fixture(t); let calls = 0; let release;
  const gate = new Promise(resolve => { release = resolve; });
  const execute = async () => { calls++; await gate; return Response.json({ taskId: "saved-task", recorded: true }, { status: 202 }); };
  const first = executeTaskRequest(f.d1, scope, admission, execute);
  const concurrent = await executeTaskRequest(f.d1, scope, admission, execute);
  assert.equal((await concurrent.json()).requestState, "pending"); assert.equal(calls, 1);
  release(); const original = await (await first).json();
  const replay = await executeTaskRequest(f.d1, scope, admission, () => assert.fail("must not execute again"));
  assert.deepEqual(await replay.json(), { ...original, replayed: true });
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM task_requests").get().n, 1);
});

test("same-key payload conflicts fail without exposing the original result", async t => {
  const f = fixture(t);
  await executeTaskRequest(f.d1, scope, admission, async () => Response.json({ taskId: "private-task" }, { status: 202 }));
  const conflict = await executeTaskRequest(f.d1, scope, { ...admission, fingerprint: "b".repeat(64) }, () => assert.fail("no action"));
  assert.equal(conflict.status, 409); assert.doesNotMatch(await conflict.text(), /private-task/);
});

test("the same key has independent tenant and principal ownership", async t => {
  const f = fixture(t); let calls = 0;
  f.sqlite.prepare("INSERT INTO tenants (id, slug, name, owner_principal) VALUES (2, 'other', 'Other', 'operator')").run();
  for (const owner of [scope, { tenantId: 1, principal: "other" }, { tenantId: 2, principal: "operator" }]) {
    const response = await executeTaskRequest(f.d1, owner, admission, async () => Response.json({ taskId: String(++calls) }, { status: 202 }));
    assert.equal((await response.json()).taskId, String(calls));
  }
  assert.equal(calls, 3);
  const replay = await executeTaskRequest(f.d1, scope, admission, () => assert.fail("private result must stay scoped"));
  assert.equal((await replay.json()).taskId, "1");
});

test("missing request storage prevents every dispatch attempt", async t => {
  const f = fixture(t); f.sqlite.exec("DROP TABLE task_requests");
  const response = await executeTaskRequest(f.d1, scope, admission, () => assert.fail("no dispatch"));
  assert.equal(response.status, 503); assert.doesNotMatch(await response.text(), /SQL|no such table/);
});

test("interrupted requests are never taken over, including after their apparent age", async t => {
  const f = fixture(t); let calls = 0;
  const response = await executeTaskRequest(f.d1, scope, admission, async () => { calls++; throw new Error("private executor failure"); });
  assert.equal(response.status, 202); assert.doesNotMatch(await response.text(), /private executor failure/);
  f.sqlite.exec("UPDATE task_requests SET created_at = '2000-01-01'");
  for (let n = 0; n < 3; n++) assert.equal((await executeTaskRequest(f.d1, scope, admission, () => assert.fail("no takeover"))).status, 202);
  assert.equal(calls, 1);
});

test("lost response receipts recover only a scoped saved task, without replaying execution", async t => {
  const f = fixture(t); let calls = 0;
  f.sqlite.exec("CREATE TRIGGER fail_receipt BEFORE UPDATE ON task_requests BEGIN SELECT RAISE(ABORT, 'private storage error'); END");
  const result = await executeTaskRequest(f.d1, scope, admission, async correlationId => {
    calls++;
    await dispatchSavedTask(f.d1, { taskId: key, tenantId: 1, account: { userId: "operator", dbUserId: null }, task: payload, conversationId: "conversation", mergePolicy: "manual", executionProvider: "managed", correlationId }, async () => new Response(null, { status: 204 }));
    return Response.json({ taskId: key }, { status: 202 });
  });
  assert.equal((await result.json()).requestState, "pending");
  const recovered = await executeTaskRequest(f.d1, scope, admission, () => assert.fail("never replay"));
  assert.equal((await recovered.json()).taskId, key); assert.equal(calls, 1);
  f.sqlite.exec("UPDATE tasks SET requested_by = 'other'");
  const hidden = await executeTaskRequest(f.d1, scope, admission, () => assert.fail("never replay"));
  assert.equal((await hidden.json()).taskId, undefined);
});

test("canonical digests bind nested request content rather than JSON property order", async () => {
  assert.equal(await taskRequestFingerprint({ a: 1, b: { c: 2, d: 3 } }), await taskRequestFingerprint({ b: { d: 3, c: 2 }, a: 1 }));
  assert.notEqual(await taskRequestFingerprint(payload), await taskRequestFingerprint({ ...payload, objective: "different" }));
});

test("browser reconnect reuses its durable key after lost responses and forgets acknowledged results", async () => {
  const saved = storage(); const observed = [];
  await assert.rejects(submitTaskRequest(payload, { storage: saved, fetcher: async (_url, options) => { observed.push(options.headers["idempotency-key"]); throw new Error("lost response"); } }));
  assert.doesNotMatch(saved.getItem(PENDING_REQUEST_STORAGE), /package.json|owner\/repo/);
  const delivered = await submitTaskRequest({ ...payload }, { storage: saved, fetcher: async (url, options) => {
    assert.equal(url, "/api/tasks/requests"); observed.push(options.headers["idempotency-key"]);
    return Response.json({ taskId: key, requestState: "completed", replayed: true }, { status: 202 });
  } });
  assert.equal(delivered.body.taskId, key); assert.equal(observed[0], observed[1]);
  assert.deepEqual(JSON.parse(saved.getItem(PENDING_REQUEST_STORAGE)), {});
  await submitTaskRequest(payload, { storage: saved, fetcher: async (_url, options) => { observed.push(options.headers["idempotency-key"]); return Response.json({ requestState: "pending" }, { status: 202 }); } });
  assert.notEqual(observed[1], observed[2]);
});

test("unavailable or corrupt browser storage fails before sending a task", async () => {
  const blocked = { getItem: () => null, setItem: () => { throw new Error("storage disabled"); } };
  await assert.rejects(submitTaskRequest(payload, { storage: blocked, fetcher: () => assert.fail("must preserve key before sending") }));
  const corrupted = { getItem: () => "{invalid" };
  await assert.rejects(submitTaskRequest(payload, { storage: corrupted, fetcher: () => assert.fail("must not discard uncertain keys") }));
});

test("built Worker request endpoint replays after reconnect without another bill or dispatch", async t => {
  const f = fixture(t);
  f.sqlite.prepare("INSERT INTO tenant_members (tenant_id, user_id, role) VALUES (1, 99, 'member')").run();
  register(`data:text/javascript,${encodeURIComponent(`export async function resolve(specifier, context, next) {
    if (specifier === "cloudflare:workers") return { url: "data:text/javascript,export const env = globalThis.__taskRequestEnv; export class DurableObject {}", shortCircuit: true };
    return next(specifier, context);
  }`)}`, import.meta.url);
  const wrap = statement => ({ ...statement, bind: (...values) => wrap(statement.bind(...values)), raw: async () => (await statement.all()).results.map(row => Object.values(row)) });
  globalThis.__taskRequestEnv = { DB: { ...f.d1, prepare: sql => wrap(f.d1.prepare(sql)) } };
  const configuration = { ATLAS_OPERATOR_TOKEN: "operator-test", ATLAS_GITHUB_TOKEN: "github-test", ATLAS_ALLOWED_REPOSITORIES: "owner/repo", ATLAS_SESSION_SECRET: "test-session-secret" };
  const previous = Object.fromEntries(Object.keys(configuration).map(k => [k, process.env[k]]));
  const originalFetch = globalThis.fetch; Object.assign(process.env, configuration);
  let dispatches = 0;
  globalThis.fetch = async (_url, options) => {
    if (options.method === "POST") { dispatches++; throw new Error("private lost acknowledgement"); }
    return Response.json({ role_name: "write" });
  };
  t.after(() => {
    globalThis.fetch = originalFetch; delete globalThis.__taskRequestEnv;
    for (const [k, value] of Object.entries(previous)) { if (value === undefined) delete process.env[k]; else process.env[k] = value; }
  });
  const { default: worker } = await import(new URL("../dist/server/index.js", import.meta.url));
  const invoke = request => worker.fetch(request, globalThis.__taskRequestEnv, { waitUntil() {}, passThroughOnException() {} });
  const session = await signSession({ uid: 99, gh: "other" }, configuration.ATLAS_SESSION_SECRET);
  const post = (data = payload, headers = {}) => new Request("https://atlas.test/api/tasks/requests", { method: "POST", headers: { cookie: `atlas_session=${session}`, "content-type": "application/json", "idempotency-key": key, ...headers }, body: JSON.stringify(data) });
  const concurrent = await Promise.all([invoke(post()), invoke(post())]);
  for (const response of concurrent) assert.equal(response.status, 202, await response.clone().text());
  const replay = await invoke(post()); const body = await replay.json();
  assert.equal(body.replayed, true); assert.equal(body.status, "dispatch-unknown"); assert.equal(body.requestState, "completed"); assert.ok(body.taskId);
  assert.doesNotMatch(JSON.stringify(body), /github-test|private lost acknowledgement|test-session-secret/);
  assert.equal(dispatches, 1); assert.equal(f.sqlite.prepare("SELECT task_count FROM task_usage").get().task_count, 1);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM tasks").get().n, 1);
  const conflict = await invoke(post({ ...payload, objective: "Changed request" })); assert.equal(conflict.status, 409);
  assert.doesNotMatch(await conflict.text(), new RegExp(body.taskId));
  assert.equal((await invoke(post(payload, { cookie: "" }))).status, 401);
  assert.equal((await invoke(post(payload, { "x-atlas-tenant": "999" }))).status, 403);
  assert.equal((await invoke(post(payload, { "idempotency-key": "invalid" }))).status, 400);
  assert.equal((await invoke(post({ ...payload, objective: "x".repeat(65537) }))).status, 413);
  let nested = {};
  for (let n = 0; n < 25; n++) nested = { child: nested };
  assert.equal((await invoke(post({ ...payload, nested }))).status, 400);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM task_requests").get().n, 1);
  f.sqlite.exec("UPDATE task_usage SET task_count = 1000000");
  const nextKey = "22222222-2222-4222-8222-222222222222";
  const denied = await invoke(post(payload, { "idempotency-key": nextKey })); assert.equal(denied.status, 402);
  const deniedAgain = await invoke(post(payload, { "idempotency-key": nextKey })); assert.equal(deniedAgain.status, 402); assert.equal((await deniedAgain.json()).replayed, true);
  assert.equal(dispatches, 1);
  f.sqlite.exec("DROP TABLE task_requests");
  assert.equal((await invoke(post())).status, 503); assert.equal(dispatches, 1);
});
