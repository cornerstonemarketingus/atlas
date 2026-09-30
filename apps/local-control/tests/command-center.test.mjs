import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { MissionService } from "../src/agent/mission-service.mjs";
import { buildCommandCenter } from "../src/platform/command-center.mjs";
import { createLocalControlServer } from "../src/server.mjs";
import { LocalTaskStore } from "../src/store.mjs";

const TOKEN = "0123456789abcdef0123456789abcdef";
const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

test("items are grouped by what they need: attention, running, waiting, done", () => {
  const view = buildCommandCenter({
    missions: [
      { id: "m1", title: "Parallel fixes", status: "running", children: [
        { id: "a", objective: "Fix login", state: "running", attempts: 1 },
        { id: "b", objective: "Fix search", state: "interrupted", attempts: 1, error: { code: "CHILD_PAUSED", message: "Lane paused by the operator." } },
      ] },
      { id: "m2", title: "Done work", status: "completed", completedAt: "2026-09-28T10:00:00Z", children: [{ id: "a", objective: "x", state: "completed", attempts: 1 }] },
      { id: "team-1", title: "Research pricing", status: "running", children: [
        { id: "s1", objective: "o", state: "running", attempts: 1, metadata: { kind: "agent_step", stepTitle: "Collect pages", agentName: "Researcher" } },
      ] },
    ],
    genesisProjects: [
      { id: "gen_1", name: "CRM", state: "building", updatedAt: "2026-09-28T11:00:00Z" },
      { id: "gen_2", name: "Site", state: "failed", updatedAt: "2026-09-28T09:00:00Z" },
      { id: "gen_3", name: "Blog", state: "planned", updatedAt: "2026-09-28T08:00:00Z" },
    ],
    tasks: [{ id: "t1", objective: "Bump deps", status: "queued", createdAt: "2026-09-28T07:00:00Z" }],
    selfImprove: { running: true, run: { startedAt: "2026-09-28T06:00:00Z" }, pending: [{ id: "p1", objective: "Tighten a check" }] },
  });

  const byId = new Map(view.items.map((item) => [item.id, item]));
  assert.equal(byId.get("m1").bucket, "attention", "a held lane needs the owner");
  assert.equal(byId.get("gen_2").bucket, "attention");
  assert.equal(byId.get("gen_3").bucket, "attention", "a plan waiting for approval needs the owner");
  assert.equal(byId.get("improve-p1").bucket, "attention");
  assert.equal(byId.get("gen_1").bucket, "running");
  assert.equal(byId.get("team-1").bucket, "running");
  assert.equal(byId.get("t1").bucket, "waiting");
  assert.equal(byId.get("m2").bucket, "done");
  assert.deepEqual([...new Set(view.items.map((item) => item.bucket))], ["attention", "running", "waiting", "done"], "ordered by bucket");
  assert.deepEqual(view.counts, { attention: 4, running: 3, waiting: 1, done: 1, lanesRunning: 2 });

  const [running, held] = byId.get("m1").lanes;
  assert.deepEqual(running.actions.map((a) => a.name), ["pause", "cancel"]);
  assert.deepEqual(held.actions.map((a) => a.name), ["resume", "cancel"]);
  assert.equal(held.actions[0].path, "/v1/missions/m1/lanes/b/control");
  assert.deepEqual(held.actions[0].body, { action: "resume" });
  assert.equal(byId.get("team-1").kind, "team");
  assert.equal(byId.get("team-1").lanes[0].title, "Collect pages");
  assert.equal(byId.get("team-1").lanes[0].agent, "Researcher");
  assert.deepEqual(byId.get("gen_2").actions.map((a) => a.path), ["/v1/genesis/gen_2/retry", "/v1/genesis/gen_2/cancel"]);
  assert.deepEqual(byId.get("m2").actions, [], "a finished mission offers nothing to press");
});

test("a finished lane links to its kernel run's trace", () => {
  const view = buildCommandCenter({ missions: [{ id: "m9", title: "Fix", status: "completed", completedAt: "2026-09-29T10:00:00Z", children: [
    { id: "a", objective: "Fix login", state: "completed", attempts: 1, result: { summary: "ok", evidence: [{ kind: "patch", path: "/p" }, { kind: "kernel_run", run: "coder-a-1f2e" }], handoff: { patch: "/p" } } },
    { id: "b", objective: "Fix search", state: "failed", attempts: 1, result: { evidence: [] } },
  ] }] });
  const [coder, none] = view.items[0].lanes;
  assert.equal(coder.run, "coder-a-1f2e");
  assert.equal(coder.trace, "/v1/world/runs/coder-a-1f2e/trace");
  assert.equal(none.trace, null);
});

test("finished work is capped so the view stays about what is happening now", () => {
  const tasks = Array.from({ length: 30 }, (_, index) => ({ id: `t${index}`, objective: "done", status: "completed", completedAt: new Date(2026, 8, 1, 0, index).toISOString() }));
  const view = buildCommandCenter({ tasks });
  assert.equal(view.items.length, 20);
  assert.equal(view.counts.done, 30);
  assert.equal(view.items[0].id, "t29", "newest first");
});

test("over HTTP: the owner pauses and resumes one lane while the other keeps running; a paired device can only watch", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "atlas-command-center-"));
  const store = new LocalTaskStore(join(directory, "atlas.sqlite"));
  const missionService = new MissionService({
    store,
    // A lane runs until the mission or the operator stops it.
    execute: ({ signal }) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })),
  });
  const server = createLocalControlServer({ store, token: TOKEN, runTask: async () => ({ ok: true }), missionService });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    for (const mission of missionService.list()) if (mission.status === "running") missionService.control(mission.id, "cancel");
    await new Promise((resolve) => server.close(resolve));
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const admin = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
  const call = (path, init = {}) => fetch(`${origin}${path}`, init).then(async (response) => ({ status: response.status, body: await response.json() }));

  const created = await call("/v1/missions", { method: "POST", headers: admin, body: JSON.stringify({
    id: "parallel", title: "Two lanes", repository: directory, model: "m", maxConcurrency: 2,
    children: [{ id: "left", objective: "Left lane", dependencies: [] }, { id: "right", objective: "Right lane", dependencies: [] }],
  }) });
  assert.equal(created.status, 201);
  await tick();

  let view = (await call("/v1/command-center", { headers: admin })).body;
  let item = view.items.find((entry) => entry.id === "parallel");
  assert.equal(item.bucket, "running");
  assert.deepEqual(item.lanes.map((lane) => lane.state), ["running", "running"]);
  assert.equal(view.counts.lanesRunning, 2);

  const { code } = (await call("/v1/pair", { method: "POST", headers: admin })).body;
  const { deviceToken } = (await call("/v1/pair/claim", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, name: "Phone" }) })).body;
  const device = { authorization: `Bearer ${deviceToken}`, "content-type": "application/json" };
  assert.equal((await call("/v1/command-center", { headers: device })).status, 200, "a paired device can watch");
  assert.equal((await call("/v1/missions/parallel/lanes/left/control", { method: "POST", headers: device, body: JSON.stringify({ action: "pause" }) })).status, 403, "but not control");

  const paused = await call("/v1/missions/parallel/lanes/left/control", { method: "POST", headers: admin, body: JSON.stringify({ action: "pause" }) });
  assert.equal(paused.status, 200);
  await tick();
  view = (await call("/v1/command-center", { headers: admin })).body;
  item = view.items.find((entry) => entry.id === "parallel");
  assert.equal(item.bucket, "attention");
  assert.equal(item.lanes[0].held, true);
  assert.equal(item.lanes[1].state, "running", "the other lane was not touched");
  assert.deepEqual(item.lanes[0].actions.map((a) => a.name), ["resume", "cancel"]);

  const resumed = await call(item.lanes[0].actions[0].path, { method: "POST", headers: admin, body: JSON.stringify(item.lanes[0].actions[0].body) });
  assert.equal(resumed.status, 200, "the action the view offered works as given");
  await tick();
  item = (await call("/v1/command-center", { headers: admin })).body.items.find((entry) => entry.id === "parallel");
  assert.deepEqual(item.lanes.map((lane) => lane.state), ["running", "running"]);

  assert.equal((await call("/v1/missions/parallel/lanes/nope/control", { method: "POST", headers: admin, body: JSON.stringify({ action: "pause" }) })).status, 404);
  assert.equal((await call("/v1/missions/parallel/lanes/left/control", { method: "POST", headers: admin, body: JSON.stringify({ action: "resume" }) })).status, 409, "resuming a lane that is not paused");
  assert.equal((await call("/v1/missions/parallel/lanes/left/control", { method: "POST", headers: admin, body: JSON.stringify({ action: "explode" }) })).status, 400);
});

test("one request launches separate tasks or several versions of one task as parallel lanes", async () => {
  const { expandLaunch } = await import("../src/agent/mission-service.mjs");
  const tasks = expandLaunch({ tasks: ["Fix login", "  ", "Add export"] });
  assert.deepEqual(tasks.children.map((lane) => [lane.id, lane.objective, lane.dependencies]), [["lane-1", "Fix login", []], ["lane-2", "Add export", []]]);
  assert.equal(tasks.title, "2 tasks in parallel");

  const versions = expandLaunch({ objective: "Redesign pricing", variants: 3 });
  assert.deepEqual(versions.children.map((lane) => lane.id), ["version-1", "version-2", "version-3"]);
  assert.ok(versions.children.every((lane) => lane.dependencies.length === 0 && lane.objective.startsWith("Redesign pricing")));
  assert.match(versions.children[1].objective, /Version 2 of 3/);
  assert.deepEqual(versions.children[2].metadata, { variant: 3, variants: 3, request: "Redesign pricing" });

  for (const bad of [{ tasks: [] }, { tasks: Array(9).fill("x") }, { objective: "x", variants: 1 }, { objective: "x", variants: 6 }, { objective: "", variants: 2 }, {}]) {
    assert.throws(() => expandLaunch(bad), { code: "INVALID_MISSION" }, JSON.stringify(bad));
  }
});

test("over HTTP: three versions run in parallel and each one's result shows in the command center", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "atlas-command-versions-"));
  const store = new LocalTaskStore(join(directory, "atlas.sqlite"));
  const objectives = [];
  const missionService = new MissionService({
    store,
    maxConcurrency: 3,
    execute: async ({ child }) => {
      objectives.push(child.objective);
      return { summary: `Built ${child.id}`, handoff: { patch: join(directory, `${child.id}.patch`), worktree: join(directory, child.id) } };
    },
  });
  const server = createLocalControlServer({ store, token: TOKEN, runTask: async () => ({ ok: true }), missionService });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const admin = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };

  const created = await fetch(`${origin}/v1/missions`, { method: "POST", headers: admin, body: JSON.stringify({ repository: directory, model: "m", objective: "Redesign the pricing page", variants: 3, maxConcurrency: 3 }) });
  assert.equal(created.status, 201);
  const mission = (await created.json()).mission;
  await tick();

  const view = await (await fetch(`${origin}/v1/command-center`, { headers: admin })).json();
  const item = view.items.find((entry) => entry.id === mission.id);
  assert.equal(item.title, "3 versions: Redesign the pricing page");
  assert.equal(item.state, "completed");
  assert.deepEqual(item.lanes.map((lane) => lane.title), ["Version 1 of 3", "Version 2 of 3", "Version 3 of 3"]);
  assert.deepEqual(item.lanes.map((lane) => lane.result.summary), ["Built version-1", "Built version-2", "Built version-3"]);
  assert.equal(item.lanes[0].result.patch, join(directory, "version-1.patch"));
  assert.equal(objectives.length, 3);
  assert.ok(objectives.every((text) => text.startsWith("Redesign the pricing page")));

  const bad = await fetch(`${origin}/v1/missions`, { method: "POST", headers: admin, body: JSON.stringify({ repository: directory, model: "m", tasks: [] }) });
  assert.equal(bad.status, 400);
});
