import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Script } from "node:vm";
import { BUSINESS_UI_JS } from "../src/agent/business-ui.mjs";
import { BusinessService } from "../src/agent/business-service.mjs";
import { MissionService } from "../src/agent/mission-service.mjs";
import { MissionScheduler } from "../src/agent/mission-scheduler.mjs";
import { LocalTaskStore } from "../src/store.mjs";
import { createLocalControlServer } from "../src/server.mjs";

async function fixture(t, execute = async ({ child }) => ({ evidence: [{ kind: "patch", path: `/patches/${child.id}`, bytes: 10 }] })) {
  const directory = await mkdtemp(join(tmpdir(), "atlas-business-"));
  const store = new LocalTaskStore(join(directory, "atlas.sqlite"));
  const missions = new MissionService({ store, execute });
  const filename = join(directory, "businesses.sqlite");
  const businesses = new BusinessService({ filename, missionService: missions });
  t.after(async () => { businesses.close(); store.close(); await rm(directory, { recursive: true, force: true }); });
  return { store, missions, businesses, filename };
}

test("business responsibilities persist independently of mission execution", async t => {
  const { businesses, missions, filename } = await fixture(t);
  const a = businesses.create({ name: "Construction", objective: "Create a customer pipeline" });
  const b = businesses.create({ name: "Marketing", objective: "Prepare campaigns" });
  const responsibility = businesses.assign(a.id, { owner: "operations", objective: "Check inquiry delivery", successCriteria: ["No failed deliveries"], intervalMs: 60000 });
  assert.equal(businesses.get(b.id).responsibilities.length, 0);
  assert.equal(businesses.due().length, 1);
  const reopened = new BusinessService({ filename, missionService: missions });
  assert.equal(reopened.get(a.id).responsibilities[0].id, responsibility.id);
  reopened.close();
  assert.throws(() => businesses.review(b.id, responsibility.id, { missionId: "missing" }), /not found/);
  assert.throws(() => businesses.assign(a.id, { owner: "ops", objective: "Check", successCriteria: [], intervalMs: 60000 }), /criteria/);
});

test("launch preparation splits budgets, passes dependency evidence and records a review", async t => {
  const seen = [];
  const { businesses, missions } = await fixture(t, async ({ child, dependencies }) => {
    seen.push({ child, dependencies });
    return { evidence: [{ kind: "patch", path: `/patches/${child.id}`, bytes: 10 }] };
  });
  const business = businesses.create({ name: "Builder", objective: "Website, hosting, CRM and leads", budget: { costMicroUsd: 100, elapsedMs: 10000 } });
  const plan = businesses.plan(business.id);
  assert.equal(plan.children.reduce((sum, child) => sum + child.budget.costMicroUsd, 0), 100);
  const responsibility = businesses.assign(business.id, { owner: "operator", objective: "Review launch artifacts", successCriteria: ["Artifacts available for inspection"], intervalMs: 60000 });
  const mission = businesses.launch(business.id, { repository: "C:/work/business", model: "local" });
  for (let count = 0; missions.get(mission.id).status !== "completed" && count < 100; count++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(missions.get(mission.id).status, "completed");
  assert.deepEqual(seen.find(item => item.child.id === "review").dependencies.map(item => item.id), ["hosting", "crm", "leads"]);
  assert.ok(seen.every(item => item.child.metadata.executionMode === "preparation"));
  const reviewed = businesses.review(business.id, responsibility.id, { missionId: mission.id });
  assert.equal(reviewed.lastReview.missionId, mission.id);
  assert.equal(businesses.due().length, 0);
  assert.equal(businesses.get(business.id).responsibilities[0].status, "active");
});

test("unsupported completion claims fail and block downstream launch work", async () => {
  for (const evidence of [undefined, [], [{ kind: "patch", path: "fake", bytes: 0 }]]) {
    const scheduler = new MissionScheduler({ plan: { id: "evidence", children: [
      { id: "build", dependencies: [], metadata: { requiredEvidence: ["patch"] } },
      { id: "deploy", dependencies: ["build"] },
    ] }, execute: async () => ({ summary: "All done", evidence }) });
    await scheduler.start();
    assert.equal(scheduler.child("build").error.code, "MISSING_EVIDENCE");
    assert.equal(scheduler.child("deploy").state, "blocked");
  }
});

test("self-improvement previews three isolated proposals behind an audit and review", async t => {
  const { businesses, missions } = await fixture(t);
  const business = businesses.create({ name: "Atlas", objective: "Improve the three biggest coding weaknesses" });
  const plan = businesses.plan(business.id, "self-improvement");
  assert.deepEqual(plan.children.slice(1, 4).map(child => child.dependencies), [["audit"], ["audit"], ["audit"]]);
  assert.deepEqual(plan.children[4].dependencies, ["improvement-1", "improvement-2", "improvement-3"]);
  assert.throws(() => businesses.plan(business.id, "unknown"), /Unknown/);
  assert.throws(() => businesses.plan(business.id, "toString"), /Unknown/);
  assert.equal(missions.list().length, 0);
});

test("business HTTP writes require the owner, reads require authentication, and preview runs nothing", async t => {
  const { businesses, missions, store } = await fixture(t);
  const token = "0123456789abcdef0123456789abcdef";
  const server = createLocalControlServer({ store, token, runTask: async () => ({ ok: true }), missionService: missions, businessService: businesses });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const page = await fetch(`${origin}/businesses`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /src="\/businesses.js"/);
  assert.match(page.headers.get("content-security-policy"), /script-src 'self'/);
  assert.equal((await fetch(`${origin}/businesses.js`)).status, 200);
  new Script(BUSINESS_UI_JS);
  assert.equal((await fetch(`${origin}/v1/businesses`)).status, 401);
  const created = await fetch(`${origin}/v1/businesses`, { method: "POST", headers, body: JSON.stringify({ name: "Builder", objective: "Launch website" }) });
  assert.equal(created.status, 201);
  const { business } = await created.json();
  assert.equal((await fetch(`${origin}/v1/businesses/${business.id}/plan`, { headers })).status, 200);
  assert.equal(missions.list().length, 0);
  const { code } = await (await fetch(`${origin}/v1/pair`, { method: "POST", headers })).json();
  const { deviceToken } = await (await fetch(`${origin}/v1/pair/claim`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, name: "Phone" }) })).json();
  const device = { authorization: `Bearer ${deviceToken}`, "content-type": "application/json" };
  assert.equal((await fetch(`${origin}/v1/businesses`, { headers: device })).status, 200);
  assert.equal((await fetch(`${origin}/v1/businesses/${business.id}/launch`, { method: "POST", headers: device, body: "{}" })).status, 403);
  assert.equal((await fetch(`${origin}/v1/businesses`, { method: "POST", headers, body: "[]" })).status, 400);
});
