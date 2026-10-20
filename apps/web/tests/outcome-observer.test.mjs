import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import fs from "node:fs";
import { migratedDatabase } from "./helpers/d1-sqlite.mjs";
import { dispatchSavedTask } from "../app/api/tasks/durable-dispatch.mjs";
import { grantTaskExecution } from "../app/api/tasks/execution-claims.mjs";
import { configureObservation, observationCandidates, reserveObservation, observeOutcomes, OBSERVATION_POLICY as P } from "../app/api/tasks/outcome-observer.mjs";
import { scheduledOutcomeObservation } from "../worker/outcome-observer.mjs";
import { configureTaskObservation } from "../app/build/request-inspection-client.mjs";
import { signSession } from "../app/api/auth/session.mjs";
const now = Date.parse("2026-10-17T12:00:00Z");
const scope = { tenantId: 1, principal: "operator" };
const idFor = n => `${n.toString(16).padStart(8, "0")}-1111-4111-8111-111111111111`;
async function addTask(f, n = 1) {
  const task = { taskId: idFor(n), tenantId: 1, requestedBy: "operator", repository: "cornerstonemarketingus/atlas", branch: "main", mode: "coder", objective: "Fix tests", mergePolicy: "manual", correlationId: `cor_${idFor(n).replaceAll("-", "")}`, conversationId: `conversation-${n}`, executionProvider: "managed", dispatchState: "dispatched", githubRunId: null };
  await dispatchSavedTask(f.d1, { ...task, account: { userId: "operator", dbUserId: null }, task }, async () => new Response(null, { status: 204 }));
  f.sqlite.prepare("INSERT INTO task_requests (tenant_id, requested_by, request_key, fingerprint, correlation_id, state) VALUES (1, 'operator', ?, ?, ?, 'reserved')").run(task.taskId, "a".repeat(64), task.correlationId);
  await grantTaskExecution(f.d1, task, { run_id: String(100 + n), run_attempt: "1" }, new Date(now - P.lifetimeMs * 2));
  return task;
}
async function fixture(t) { const f = migratedDatabase({ users: [[99, "other"]] }); t.after(() => f.sqlite.close()); const task = await addTask(f); return { ...f, task }; }
const candidate = task => ({ taskId: task.taskId, ...scope, requestKey: task.taskId });
const never = () => assert.fail("No external verification permitted");
const verify = async (task, claim) => ({ identity: { run_id: String(claim.runId), run_attempt: String(claim.runAttempt) }, outcome: { ...claim, jobId: 456, headSha: "a".repeat(40), conclusion: "failure", completedAt: new Date(now - 1000).toISOString() } });
function seed(f, taskId, count, { tenant = 1, day = Math.floor(now / P.lifetimeMs), start = 0 } = {}) {
  const insert = f.sqlite.prepare("INSERT INTO task_outcome_observations (task_id, tenant_id, requested_by, run_id, run_attempt, slot, day, status, started_at) VALUES (?, ?, 'operator', 101, 1, ?, ?, 'reserved', ?)");
  for (let i = 0; i < count; i++) insert.run(taskId, tenant, start + i, day, now - P.intervalMs);
}

test("automatic observation is opt-in; disabling does not create or extend a watch", async t => {
  const f = await fixture(t); assert.deepEqual(await observationCandidates(f.d1, now), []);
  assert.deepEqual(await observeOutcomes(f.d1, never, () => now), { reserved: 0, observed: 0, unavailable: 0 });
  assert.equal((await configureObservation(f.d1, scope, f.task.taskId, null, false, now)).status, "configured");
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM task_outcome_watches").get().n, 0);
  const first = await configureObservation(f.d1, scope, f.task.taskId, null, true, now); assert.equal(first.status, "configured");
  assert.equal(first.request.task.execution.observation.expiresAt, new Date(now + P.lifetimeMs).toISOString());
  await configureObservation(f.d1, scope, f.task.taskId, null, false, now + 1000);
  await configureObservation(f.d1, scope, f.task.taskId, null, true, now + 2000);
  assert.equal(f.sqlite.prepare("SELECT expires_at FROM task_outcome_watches").get().expires_at, now + P.lifetimeMs);
  assert.equal((await configureObservation(f.d1, scope, f.task.taskId, null, true, now + P.lifetimeMs)).status, "not-eligible");
  assert.deepEqual(await observationCandidates(f.d1, now + P.lifetimeMs), []);
});

test("foreign consent and revoked membership cannot authorize observation", async t => {
  const f = await fixture(t);
  assert.equal((await configureObservation(f.d1, { ...scope, principal: "foreign" }, f.task.taskId, null, true, now)).status, "not-found");
  assert.equal((await configureObservation(f.d1, scope, f.task.taskId, 99, true, now)).status, "not-eligible");
  f.sqlite.exec("UPDATE tasks SET requested_by = 'github:other', user_id = 99; UPDATE conversations SET requested_by = 'github:other'; UPDATE task_requests SET requested_by = 'github:other'; UPDATE task_execution_claims SET requested_by = 'github:other'");
  const member = { ...scope, principal: "github:other" };
  assert.equal((await configureObservation(f.d1, member, f.task.taskId, 99, true, now)).status, "not-eligible");
  f.sqlite.exec("INSERT INTO tenant_members (tenant_id,user_id,role) VALUES (1,99,'member')");
  assert.equal((await configureObservation(f.d1, member, f.task.taskId, 99, true, now)).status, "configured");
  assert.equal((await observationCandidates(f.d1, now)).length, 1);
  f.sqlite.exec("DELETE FROM tenant_members");
  assert.deepEqual(await observationCandidates(f.d1, now), []);
  assert.equal(await reserveObservation(f.d1, { ...candidate(f.task), principal: "github:other" }, now), null);
});

test("duplicate cron slots and audit rollback cannot repeat or refund metadata reads", async t => {
  const f = await fixture(t); await configureObservation(f.d1, scope, f.task.taskId, null, true, now);
  assert.equal(await reserveObservation(f.d1, candidate(f.task), now), Math.floor(now / P.intervalMs));
  assert.equal(await reserveObservation(f.d1, candidate(f.task), now + 1), null);
  assert.deepEqual(await observeOutcomes(f.d1, never, () => now + 2), { reserved: 0, observed: 0, unavailable: 0 });
  assert.throws(() => f.sqlite.exec("DELETE FROM task_outcome_observations"), /refunded/);
  f.sqlite.exec("CREATE TRIGGER fail_observation_audit BEFORE INSERT ON run_events WHEN NEW.kind='observation' BEGIN SELECT RAISE(ABORT,'private'); END");
  await assert.rejects(reserveObservation(f.d1, candidate(f.task), now + P.intervalMs));
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM task_outcome_observations").get().n, 1);
});

test("task, tenant and global budgets count uncertain reservations and survive toggles", async t => {
  const f = await fixture(t); const other = await addTask(f, 2);
  await configureObservation(f.d1, scope, f.task.taskId, null, true, now); await configureObservation(f.d1, scope, other.taskId, null, true, now);
  seed(f, f.task.taskId, 8);
  assert.equal(await reserveObservation(f.d1, candidate(f.task), now), null);
  assert.equal(await reserveObservation(f.d1, candidate(f.task), now + P.lifetimeMs / 2), null, "task ceiling survives a UTC-day reset");
  assert.equal(await reserveObservation(f.d1, candidate(other), now), null, "tenant ceiling includes another task's reserved checks");
  await configureObservation(f.d1, scope, f.task.taskId, null, false, now + 1); await configureObservation(f.d1, scope, f.task.taskId, null, true, now + 2);
  assert.equal(await reserveObservation(f.d1, candidate(f.task), now + 3), null);
  f.sqlite.exec("UPDATE task_outcome_observations SET tenant_id=2");
  seed(f, f.task.taskId, 40, { tenant: 2, start: 20 });
  assert.equal(await reserveObservation(f.d1, candidate(other), now), null, "global ceiling applies across tenants");
  assert.deepEqual(await observationCandidates(f.d1, now), []);
});

test("a tick observes at most two tasks, saves outcomes and stops completed watches", async t => {
  const f = await fixture(t); const tasks = [f.task, await addTask(f, 2), await addTask(f, 3)];
  for (const task of tasks) await configureObservation(f.d1, scope, task.taskId, null, true, now);
  const result = await observeOutcomes(f.d1, verify, () => now);
  assert.deepEqual(result, { reserved: 2, observed: 2, unavailable: 0 });
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM task_execution_outcomes").get().n, 2);
  assert.equal((await observationCandidates(f.d1, now)).length, 1);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM conversation_messages WHERE id LIKE 'result:%'").get().n, 0);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM task_usage").get().n, 0);
});

test("provider failure consumes one bounded reservation; no retry within the same slot", async t => {
  const f = await fixture(t); await configureObservation(f.d1, scope, f.task.taskId, null, true, now);
  let calls = 0; const failure = async () => { calls++; throw new Error("private provider token"); };
  assert.deepEqual(await observeOutcomes(f.d1, failure, () => now), { reserved: 1, observed: 0, unavailable: 1 });
  await observeOutcomes(f.d1, failure, () => now); assert.equal(calls, 1);
  assert.equal(f.sqlite.prepare("SELECT status FROM task_outcome_observations").get().status, "unavailable");
  await configureObservation(f.d1, scope, f.task.taskId, null, false, now + 1);
  assert.deepEqual(await observationCandidates(f.d1, now + P.intervalMs), []);
});

test("runtime makes no credential request when inactive and sends only bounded metadata GETs when active", async t => {
  const f = await fixture(t); assert.equal((await scheduledOutcomeObservation({ DB: f.d1 }, never)).status, "checked");
  await configureObservation(f.d1, scope, f.task.taskId, null, true, Date.now());
  let reads = 0;
  const response = await scheduledOutcomeObservation({ DB: f.d1, ATLAS_GITHUB_TOKEN: "fake-observer-token" }, async (url, options) => {
    reads++; assert.equal(options.redirect, "manual"); assert.ok(options.signal); assert.equal(options.headers.authorization, "Bearer fake-observer-token");
    assert.match(String(url), /^https:\/\/api.github.com\/repos\/cornerstonemarketingus\/atlas\/actions\/runs\/101\/attempts\/1/);
    const sha = "a".repeat(40);
    return String(url).includes("/jobs?") ? Response.json({ total_count: 1, jobs: [{ id: 456, name: "run", run_id: 101, run_attempt: 1, status: "completed", conclusion: "failure", head_sha: sha, head_branch: "main", workflow_name: "Atlas Coder", completed_at: new Date(Date.now()-1000).toISOString() }] }) : Response.json({ id: 101, run_attempt: 1, event: "workflow_dispatch", head_branch: "main", head_sha: sha, path: ".github/workflows/atlas-coder.yml", display_title: `Atlas Coder · task ${f.task.taskId}`, repository: { id: 1337761549, full_name: "cornerstonemarketingus/atlas" } });
  });
  assert.equal(response.observed, 1); assert.equal(reads, 2);
  assert.equal((await scheduledOutcomeObservation({})).status, "disabled");
});

test("mobile consent sends only request identity and an enabled boolean", async () => {
  assert.equal((await configureTaskObservation({ requestKey: idFor(1), enabled: true, fetcher: async (url, options) => {
    assert.equal(url, `/api/tasks/requests/${idFor(1)}/observation`); assert.equal(options.body, '{"enabled":true}'); assert.ok(options.signal); return Response.json({ ok: true });
  } })).ok, true);
  await assert.rejects(configureTaskObservation({ requestKey: "bad", enabled: true, fetcher: never }));
});

test("concurrent ticks share atomic global and tenant budgets", async t => {
  for (const mode of ["global", "tenant"]) {
    const f = await fixture(t); const other = await addTask(f, 2); const third = await addTask(f, 3);
    for (const task of [f.task, other, third]) await configureObservation(f.d1, scope, task.taskId, null, true, now);
    seed(f, other.taskId, mode === "global" ? 47 : 7, { tenant: mode === "global" ? 2 : 1 });
    let chain = Promise.resolve(); const d1 = { ...f.d1, batch: statements => { const op = chain.then(() => f.d1.batch(statements)); chain = op.catch(() => {}); return op; } };
    const slots = await Promise.all([reserveObservation(d1, candidate(f.task), now), reserveObservation(d1, candidate(third), now)]);
    assert.equal(slots.filter(value => value !== null).length, 1);
  }
});

test("built Worker exposes authenticated opt-in and scheduled observation with no browser connection", async t => {
  const f = await fixture(t);
  register(`data:text/javascript,${encodeURIComponent(`export async function resolve(specifier, context, next) {
    if (specifier === "cloudflare:workers") return { url: "data:text/javascript,export const env = globalThis.__observerEnv; export class DurableObject {}", shortCircuit: true };
    return next(specifier, context);
  }`)}`, import.meta.url);
  const wrap = statement => ({ ...statement, bind: (...values) => wrap(statement.bind(...values)), raw: async () => (await statement.all()).results.map(row => Object.values(row)) });
  globalThis.__observerEnv = { DB: { ...f.d1, prepare: sql => wrap(f.d1.prepare(sql)) }, ATLAS_GITHUB_TOKEN: "fake-observer-github" };
  const config = { ATLAS_OPERATOR_TOKEN: "observer-owner", ATLAS_SESSION_SECRET: "observer-test-secret" };
  const previous = Object.fromEntries(Object.keys(config).map(key => [key, process.env[key]])); Object.assign(process.env, config);
  const originalFetch = globalThis.fetch; let reads = 0;
  globalThis.fetch = async (url, options) => {
    reads++; assert.equal(options.redirect, "manual"); assert.equal(options.headers.authorization, "Bearer fake-observer-github");
    const sha = "a".repeat(40);
    return String(url).includes("/jobs?") ? Response.json({ total_count: 1, jobs: [{ id: 456, name: "run", run_id: 101, run_attempt: 1, status: "completed", conclusion: "cancelled", head_sha: sha, head_branch: "main", workflow_name: "Atlas Coder", completed_at: new Date(Date.now()-1000).toISOString() }] }) : Response.json({ id: 101, run_attempt: 1, event: "workflow_dispatch", head_branch: "main", head_sha: sha, path: ".github/workflows/atlas-coder.yml", display_title: `Atlas Coder · task ${f.task.taskId}`, repository: { id: 1337761549, full_name: "cornerstonemarketingus/atlas" } });
  };
  t.after(() => { globalThis.fetch = originalFetch; delete globalThis.__observerEnv; for (const [key,value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const { default: worker } = await import(new URL("../dist/server/index.js", import.meta.url));
  const endpoint = `https://atlas.test/api/tasks/requests/${f.task.taskId}/observation`;
  const invoke = (headers = {}, body = '{"enabled":true}') => worker.fetch(new Request(endpoint, { method: "POST", headers: { authorization: "Bearer observer-owner", "content-type": "application/json", ...headers }, body }), globalThis.__observerEnv, { waitUntil() {}, passThroughOnException() {} });
  assert.equal((await invoke({ authorization: "Bearer wrong" })).status, 401);
  assert.equal((await invoke({ origin: "https://foreign.test" })).status, 403);
  assert.equal((await invoke({ "sec-fetch-site": "cross-site" })).status, 403);
  assert.equal((await invoke({}, '{"enabled":true,"limit":999}')).status, 400);
  assert.equal((await invoke({}, "x".repeat(300))).status, 400);
  const session = await signSession({ uid: 99, gh: "other" }, config.ATLAS_SESSION_SECRET);
  f.sqlite.exec("INSERT INTO tenant_members (tenant_id,user_id,role) VALUES (1,99,'member')");
  assert.equal((await invoke({ authorization: "", cookie: `atlas_session=${session}` })).status, 404);
  assert.equal(reads, 0);
  const enabled = await invoke({ origin: "https://atlas.test" }); assert.equal(enabled.status, 200, await enabled.clone().text());
  assert.equal(enabled.headers.get("cache-control"), "no-store"); assert.equal((await enabled.json()).request.task.execution.observation.enabled, true);
  assert.equal(typeof worker.scheduled, "function");
  const pending = [];
  await worker.scheduled({ scheduledTime: Date.now(), cron: "*/15 * * * *" }, globalThis.__observerEnv, { waitUntil: promise => pending.push(promise) });
  await Promise.all(pending); assert.equal(reads, 2);
  assert.equal(f.sqlite.prepare("SELECT conclusion FROM task_execution_outcomes").get().conclusion, "cancelled");
  const refreshed = await worker.fetch(new Request(`https://atlas.test/api/tasks/requests/${f.task.taskId}`, { headers: { authorization: "Bearer observer-owner" } }), globalThis.__observerEnv, { waitUntil() {}, passThroughOnException() {} });
  assert.equal(refreshed.status, 200); const current = (await refreshed.json()).request;
  assert.equal(current.task.execution.outcome.conclusion, "cancelled"); assert.equal(current.task.execution.observation.attempts, 1);
  const repeated = []; await worker.scheduled({ scheduledTime: Date.now(), cron: "*/15 * * * *" }, globalThis.__observerEnv, { waitUntil: promise => repeated.push(promise) }); await Promise.all(repeated); assert.equal(reads, 2);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM conversation_messages WHERE id LIKE 'result:%'").get().n, 0);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM task_usage").get().n, 0);
  assert.equal((await invoke({}, '{"enabled":false}')).status, 200);
  const configuration = JSON.parse(fs.readFileSync(new URL("../dist/server/wrangler.json", import.meta.url), "utf8"));
  assert.deepEqual(configuration.triggers.crons, ["*/15 * * * *"]);
  f.sqlite.exec("DROP TABLE task_outcome_observations");
  const unavailable = await invoke(); assert.equal(unavailable.status, 503); assert.doesNotMatch(await unavailable.text(), /SQL|no such table|fake-observer/);
});

test("deadline stops a second observation without another reservation", async t => {
  const f = await fixture(t); const second = await addTask(f, 2);
  for (const task of [f.task, second]) await configureObservation(f.d1, scope, task.taskId, null, true, now);
  let clock = now; let calls = 0;
  const result = await observeOutcomes(f.d1, async (task, claim) => { calls++; clock += 55000; return verify(task, claim); }, () => clock);
  assert.equal(result.reserved, 1); assert.equal(calls, 1);
});

test("active-watch capacity cannot be bypassed by repeated consent", async t => {
  const f = await fixture(t);
  for (let i = 1; i <= P.activeTenant; i++) {
    const task = i === 1 ? f.task : await addTask(f, i);
    assert.equal((await configureObservation(f.d1, scope, task.taskId, null, true, now)).status, "configured");
  }
  const extra = await addTask(f, 100);
  assert.equal((await configureObservation(f.d1, scope, extra.taskId, null, true, now)).status, "not-eligible");
  assert.equal((await configureObservation(f.d1, scope, f.task.taskId, null, true, now)).status, "configured");
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM task_outcome_watches WHERE enabled=1").get().n, P.activeTenant);
});


test("consent audit failure cannot leave an unaudited enabled watch", async t => {
  const f = await fixture(t);
  f.sqlite.exec("CREATE TRIGGER fail_consent_audit BEFORE INSERT ON run_events WHEN NEW.kind='observation-setting' BEGIN SELECT RAISE(ABORT,'private failure'); END");
  await assert.rejects(configureObservation(f.d1, scope, f.task.taskId, null, true, now));
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM task_outcome_watches").get().n, 0);
  assert.deepEqual(await observationCandidates(f.d1, now), []);
});
