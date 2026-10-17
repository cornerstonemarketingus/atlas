import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { CloudMissions } from "../app/api/missions/service.mjs";
import { missionRoutes } from "../app/api/missions/http.mjs";
import { migratedDatabase } from "./helpers/d1-sqlite.mjs";
const scope = { tenantId: 1, principal: "operator" };
const plan = () => ({ requestId: randomUUID(), objective: "Review then check repository", steps: [
  { id: "review", dependencies: [], repository: "owner/repo", branch: "main", mode: "inspect", objective: "Review README.md and report issues" },
  { id: "check", dependencies: ["review"], repository: "owner/repo", branch: "main", mode: "debug", objective: "Run the documented tests and report failures" },
] });
function fixture(t, overrides = {}) {
  const { sqlite, d1 } = migratedDatabase();
  // D1 batches are serial transactions; serialize the async SQLite shim too.
  const batch = d1.batch; let tail = Promise.resolve();
  d1.batch = statements => { const next = tail.then(() => batch(statements)); tail = next.catch(() => {}); return next; };
  sqlite.exec(readFileSync(new URL("../drizzle/0021_cloud_missions.sql", import.meta.url), "utf8"));
  t.after(() => sqlite.close());
  const calls = [];
  const service = new CloudMissions({ db: d1,
    dispatch: async (_scope, step) => { calls.push(step.id); return { taskId: randomUUID(), correlationId: step.correlationId }; },
    receipt: async () => null, outcome: async () => ({ status: "pending" }), ...overrides });
  return { sqlite, d1, service, calls };
}
test("mission creation is idempotent and private to both workspace and principal", async t => {
  const { service } = fixture(t);
  const input = plan();
  const created = await service.create(scope, input);
  assert.equal((await service.create(scope, input)).steps[0].correlationId, created.steps[0].correlationId);
  await assert.rejects(service.create(scope, { ...input, objective: "Different" }), { status: 409 });
  assert.equal(await service.get({ ...scope, tenantId: 2 }, created.id), null);
  assert.equal(await service.get({ ...scope, principal: "other" }, created.id), null);
  assert.equal((await service.list(scope)).length, 1);
  await assert.rejects(service.create(scope, { ...plan(), steps: [plan().steps[1]] }), /earlier steps/);
  await assert.rejects(service.create(scope, { ...plan(), steps: Array(9).fill(plan().steps[0]) }), /1-8/);
});
test("concurrent resume requests dispatch once and a restarted service preserves ownership", async t => {
  const { service, d1, calls } = fixture(t);
  const created = await service.create(scope, plan());
  await Promise.all(Array.from({ length: 8 }, () => service.advance(scope, created.id)));
  assert.deepEqual(calls, ["review"]);
  const restarted = new CloudMissions({ ...service, db: d1 });
  await restarted.advance(scope, created.id);
  assert.deepEqual(calls, ["review"]);
  assert.equal((await restarted.get(scope, created.id)).dispatchCount, 1);
});
test("missing evidence cannot advance dependencies; verified outcomes survive reconnect", async t => {
  let verified = false;
  const { service, calls } = fixture(t, { outcome: async () => ({ status: "completed", ...(verified ? { evidence: { receiptId: "signed-result", runUrl: "https://github.com/owner/repo/actions/runs/1" } } : {}) }) });
  const created = await service.create(scope, plan());
  await service.advance(scope, created.id);
  await service.advance(scope, created.id);
  assert.deepEqual(calls, ["review"]);
  verified = true;
  await service.advance(scope, created.id);
  assert.deepEqual(calls, ["review", "check"]);
  const completed = await service.advance(scope, created.id);
  assert.equal(completed.status, "completed");
  assert.equal(completed.dispatchCount, 2);
  assert.ok(completed.steps.every(step => step.evidence.receiptId === "signed-result"));
  await service.advance(scope, created.id);
  assert.equal(calls.length, 2);
});
test("a lost acknowledgement becomes uncertain and never blindly replays", async t => {
  let count = 0;
  const { service } = fixture(t, { dispatch: async () => { count++; throw new Error("transport lost"); } });
  const created = await service.create(scope, plan());
  assert.equal((await service.advance(scope, created.id)).steps[0].state, "uncertain");
  await service.advance(scope, created.id);
  await service.control(scope, created.id, "pause");
  await service.control(scope, created.id, "resume");
  await service.advance(scope, created.id);
  assert.equal(count, 1);
});
test("an intent left by a crashed request reconciles a matching receipt without redispatch", async t => {
  const taskId = randomUUID();
  const { service, sqlite, calls } = fixture(t, { now: () => 100000, receipt: async (_scope, correlation, step) => { assert.equal(correlation, step.correlationId); return { taskId }; } });
  const mission = await service.create(scope, plan());
  mission.steps[0].state = "dispatching"; mission.steps[0].leaseUntil = 0; mission.dispatchCount = 1;
  sqlite.prepare("UPDATE cloud_missions SET record_json=?").run(JSON.stringify(mission));
  const reconciled = await service.advance(scope, mission.id);
  assert.equal(reconciled.steps[0].taskId, taskId);
  assert.equal(reconciled.steps[0].state, "submitted");
  assert.equal(calls.length, 0);
});
test("pause during dispatch retains its receipt without reactivating the mission", async t => {
  let release;
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  const { service } = fixture(t, { dispatch: (_scope, step) => { started(); return new Promise(resolve => { release = () => resolve({ taskId: randomUUID(), correlationId: step.correlationId }); }); } });
  const created = await service.create(scope, plan());
  const pending = service.advance(scope, created.id);
  await ready;
  await service.control(scope, created.id, "pause");
  release();
  const saved = await pending;
  assert.equal(saved.status, "paused");
  assert.equal(saved.steps[0].state, "submitted");
});
test("definitive task rejection blocks future work and is never charged another dispatch", async t => {
  const { service } = fixture(t, { dispatch: async () => ({ rejected: true }) });
  const created = await service.create(scope, plan());
  const rejected = await service.advance(scope, created.id);
  assert.equal(rejected.status, "failed", "intake rejection is terminal in the response shown to the user");
  assert.equal(rejected.steps[1].state, "blocked");
  const failed = await service.advance(scope, created.id);
  assert.equal(failed.status, "failed");
  assert.equal(failed.steps[1].state, "blocked");
  assert.equal(failed.dispatchCount, 1);
});
test("real HTTP handler authenticates first, scopes requests and bounds bodies", async t => {
  const { d1 } = fixture(t);
  let signedIn = false;
  const handle = missionRoutes({ database: () => d1, authenticate: async () => signedIn ? {} : null,
    resolveScope: async () => scope, dispatch: async () => assert.fail("create does not execute"), receipt: async () => null, outcome: async () => ({}) });
  const request = body => new Request("https://atlas.test/api/missions", { method: "POST", body: JSON.stringify(body) });
  assert.equal((await handle(request(plan()))).status, 401);
  signedIn = true;
  const created = await handle(request({ ...plan(), tenantId: 999, principal: "other" }));
  assert.equal(created.status, 201);
  const id = (await created.json()).mission.id;
  assert.equal((await handle(new Request("https://atlas.test/api/missions/" + id), id)).status, 200);
  assert.equal((await handle(request({ data: "x".repeat(65000) }))).status, 413);
  assert.equal((await handle(request([]))).status, 400);
  const other = missionRoutes({ database: () => d1, authenticate: async () => ({}), resolveScope: async () => ({ ...scope, principal: "other" }) });
  assert.equal((await other(new Request("https://atlas.test/api/missions/" + id), id)).status, 404);
});
import ts from "typescript";
async function runtime(dependencies) {
  const source = readFileSync(new URL("../app/api/missions/runtime.ts", import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    transformers: { before: [() => root => ts.factory.updateSourceFile(root, root.statements.filter(node => !ts.isImportDeclaration(node)))] },
  }).outputText.replace("export const handleMission", "const handleMission").replace(/export \{\};?/gu, "");
  return new Function(...Object.keys(dependencies), `${compiled}; return handleMission;`)(...Object.values(dependencies));
}
test("production adapter forwards authorization and requires both run success and stored runner receipt", async t => {
  const { d1, sqlite } = fixture(t);
  const headers = { authorization: "Bearer test-owner", "x-atlas-tenant": "1", "content-type": "application/json" };
  const handle = await runtime({ getD1: () => d1, missionRoutes,
    authenticatedAccount: async request => request.headers.get("authorization") === headers.authorization ? { userId: "operator" } : null,
    resolveTenantContext: async () => ({ tenantId: 1, principal: "operator" }), tenantScope: value => value,
    startTask: async request => {
      assert.equal(request.headers.get("authorization"), headers.authorization);
      assert.equal(request.headers.get("x-atlas-tenant"), "1");
      const task = await request.json(); const taskId = randomUUID(); const conversationId = randomUUID(); const correlationId = request.headers.get("x-atlas-correlation-id");
      sqlite.prepare("INSERT INTO conversations(id,tenant_id,requested_by,title,repository,branch) VALUES (?,1,'operator','mission',?,?)").run(conversationId, task.repository, task.branch);
      sqlite.prepare("INSERT INTO tasks(task_id,tenant_id,requested_by,repository,branch,mode,objective,conversation_id,correlation_id,github_run_id) VALUES (?,1,'operator',?,?,?,?,?,?,123)").run(taskId, task.repository, task.branch, task.mode, task.objective, conversationId, correlationId);
      return Response.json({ taskId, correlationId, runner: "managed", recorded: true }, { status: 202 });
    },
    githubAppConfiguration: () => ({ configured: false }), platformGitHubToken: () => "server-token",
    workflowRunRequest: input => { assert.equal(input.token, "server-token"); assert.equal(input.repository, "owner/repo"); return input; },
    fetchGitHubJson: async () => ({ id: 123, run_attempt: 2, status: "completed", conclusion: "success", html_url: "https://github.com/owner/repo/actions/runs/123" }),
    runBelongsToTask: (_run, taskId) => Boolean(sqlite.prepare("SELECT task_id FROM tasks WHERE task_id=?").get(taskId)),
  });
  const input = plan(); input.steps = [input.steps[0]];
  const post = (body, id) => handle(new Request("https://atlas.test/api/missions" + (id ? `/${id}` : ""), { method: "POST", headers, body: JSON.stringify(body) }), id ?? null);
  assert.equal((await post(input)).status, 201);
  const dispatched = (await (await post({ action: "advance" }, input.requestId)).json()).mission;
  const waiting = (await (await post({ action: "advance" }, input.requestId)).json()).mission;
  assert.equal(waiting.steps[0].state, "submitted", "GitHub success alone is insufficient");
  const row = sqlite.prepare("SELECT conversation_id AS conversationId FROM tasks WHERE task_id=?").get(dispatched.steps[0].taskId);
  sqlite.prepare("INSERT INTO run_events(id,conversation_id,task_id,requested_by,kind,label,detail) VALUES (?,?,?,'operator','result','Runner results received','Verified report')").run(`result:${dispatched.steps[0].taskId}:123:1`, row.conversationId, dispatched.steps[0].taskId);
  const stale = (await (await post({ action: "advance" }, input.requestId)).json()).mission;
  assert.equal(stale.steps[0].state, "submitted", "a previous attempt receipt cannot complete the current attempt");
  sqlite.prepare("INSERT INTO run_events(id,conversation_id,task_id,requested_by,kind,label,detail) VALUES (?,?,?,'operator','result','Runner results received','Verified report')").run(`result:${dispatched.steps[0].taskId}:123:2`, row.conversationId, dispatched.steps[0].taskId);
  const completed = (await (await post({ action: "advance" }, input.requestId)).json()).mission;
  assert.equal(completed.status, "completed");
  assert.equal(completed.steps[0].evidence.receiptId, `result:${dispatched.steps[0].taskId}:123:2`);
});
test("an audit insert failure rolls back dispatch intent before external execution", async t => {
  const { service, sqlite, calls } = fixture(t);
  const created = await service.create(scope, plan());
  sqlite.exec("CREATE TRIGGER fail_audit BEFORE INSERT ON cloud_mission_events WHEN NEW.kind='dispatch-intent' BEGIN SELECT RAISE(ABORT,'audit unavailable'); END;");
  await assert.rejects(service.advance(scope, created.id), /audit unavailable/);
  assert.equal(calls.length, 0);
  assert.equal((await service.get(scope, created.id)).dispatchCount, 0);
  assert.equal((await service.get(scope, created.id)).steps[0].state, "waiting");
});
test("audit events are append-only and paused/stopped work records outcomes without another dispatch", async t => {
  const { service, sqlite, calls } = fixture(t, { outcome: async () => ({ status: "completed", evidence: { receiptId: "verified" } }) });
  const created = await service.create(scope, plan());
  await service.advance(scope, created.id);
  await service.control(scope, created.id, "stop");
  const stopped = await service.advance(scope, created.id);
  assert.equal(stopped.status, "stopped");
  assert.equal(stopped.steps[0].state, "completed");
  assert.equal(stopped.steps[1].state, "waiting");
  assert.deepEqual(calls, ["review"]);
  assert.throws(() => sqlite.exec("UPDATE cloud_mission_events SET kind='tampered'"), /append-only/);
  assert.throws(() => sqlite.exec("DELETE FROM cloud_mission_events"), /append-only/);
});

test("a paid allowance refusal fails immediately without uncertain recovery or another charge", async t => {
  const { d1 } = fixture(t); let calls = 0;
  const handle = await runtime({ getD1: () => d1, missionRoutes,
    authenticatedAccount: async () => ({ userId: "operator" }),
    resolveTenantContext: async () => scope, tenantScope: value => value,
    githubAppConfiguration: () => ({ configured: false }), platformGitHubToken: () => "server-token",
    startTask: async () => { calls++; return Response.json({ message: "Monthly task allowance exhausted" }, { status: 402 }); },
  });
  const input = plan();
  const post = (body, id) => handle(new Request("https://atlas.test/api/missions" + (id ? `/${id}` : ""), { method: "POST", body: JSON.stringify(body) }), id ?? null);
  await post(input);
  const failed = (await (await post({ action: "advance" }, input.requestId)).json()).mission;
  assert.equal(failed.status, "failed");
  assert.equal(failed.steps[0].state, "failed");
  assert.match(failed.steps[0].message, /Monthly task allowance exhausted/);
  assert.equal(failed.steps[1].state, "blocked");
  await post({ action: "advance" }, input.requestId);
  assert.equal(calls, 1);
});

test("saved mission history remains reachable past 30 records with scoped stable cursors", async t => {
  const { service, d1 } = fixture(t, { now: () => 100000 }); const ids = [];
  for (let i = 0; i < 65; i++) { const input = { ...plan(), requestId: randomUUID(), objective: `Mission ${i}` }; ids.push((await service.create(scope, input)).id); }
  await service.create({ ...scope, principal: "other" }, { ...plan(), requestId: randomUUID(), objective: "Private other mission" });
  const all = []; let cursor = null; let pages = 0;
  do { const result = await service.listPage(scope, cursor); all.push(...result.missions); cursor = result.nextCursor; pages++; assert.ok(result.missions.length <= 30); } while (cursor && pages < 5);
  assert.equal(pages, 3); assert.equal(all.length, 65); assert.deepEqual(all.map(mission => mission.id), ids.sort());
  assert.ok(all.every(mission => !Object.hasOwn(mission, "steps")), "history stays a bounded summary");
  const handle = missionRoutes({ database: () => d1, authenticate: async () => ({}), resolveScope: async () => scope });
  const first = await (await handle(new Request("https://atlas.test/api/missions"))).json();
  assert.equal(first.missions.length, 30); assert.equal(typeof first.nextCursor, "string");
  const second = await (await handle(new Request(`https://atlas.test/api/missions?cursor=${first.nextCursor}`))).json();
  assert.equal(second.missions.length, 30); assert.equal(new Set([...first.missions, ...second.missions].map(mission => mission.id)).size, 60);
  for (const bad of ["not-a-cursor", Buffer.from(JSON.stringify(["1970-01-01T00:01:40.000Z", [ids[0]]])).toString("base64url")]) {
    assert.equal((await handle(new Request(`https://atlas.test/api/missions?cursor=${bad}`))).status, 400);
  }
});

for (const scenario of ["unconfigured", "unrecorded", "private"]) {
  test(`mission runtime avoids unsupported or unconfirmed execution: ${scenario}`, async t => {
    const { d1, sqlite } = fixture(t); let calls = 0; const taskId = randomUUID();
    const handle = await runtime({ getD1: () => d1, missionRoutes,
      authenticatedAccount: async () => ({ userId: "operator" }), resolveTenantContext: async () => scope, tenantScope: value => value,
      githubAppConfiguration: () => ({ configured: false }), platformGitHubToken: () => scenario === "unconfigured" ? null : "server-token",
      startTask: async request => {
        calls++; const correlationId = request.headers.get("x-atlas-correlation-id");
        if (scenario === "private") {
          const body = await request.json(); const conversationId = randomUUID();
          sqlite.prepare("INSERT INTO conversations(id,tenant_id,requested_by,title,repository,branch) VALUES (?,1,'operator','private',?,?)").run(conversationId, body.repository, body.branch);
          sqlite.prepare("INSERT INTO tasks(task_id,tenant_id,requested_by,repository,branch,mode,objective,conversation_id,correlation_id,execution_provider) VALUES (?,1,'operator',?,?,?,?,?,?,'private')").run(taskId, body.repository, body.branch, body.mode, body.objective, conversationId, correlationId);
        }
        return Response.json({ taskId, correlationId, runner: scenario === "private" ? "private" : "managed", recorded: scenario !== "unrecorded" }, { status: 202 });
      },
    });
    const input = plan();
    const post = (body, id) => handle(new Request("https://atlas.test/api/missions" + (id ? `/${id}` : ""), { method: "POST", body: JSON.stringify(body) }), id ?? null);
    await post(input);
    const mission = (await (await post({ action: "advance" }, input.requestId)).json()).mission;
    assert.equal(mission.steps[0].state, scenario === "unconfigured" ? "failed" : "uncertain");
    if (scenario === "unconfigured") { assert.equal(mission.status, "failed"); assert.match(mission.steps[0].message, /managed GitHub Actions/); }
    else { assert.equal(mission.steps[0].taskId, taskId); assert.match(mission.steps[0].message, /no retry was sent/); }
    const reconciled = (await (await post({ action: "advance" }, input.requestId)).json()).mission;
    assert.equal(reconciled.steps[0].state, mission.steps[0].state, "private receipts cannot be promoted to managed execution");
    assert.equal(calls, scenario === "unconfigured" ? 0 : 1);
  });
}
