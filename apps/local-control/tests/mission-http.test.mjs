import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createLocalControlServer } from "../src/server.mjs";
import { LocalTaskStore } from "../src/store.mjs";

const TOKEN = "0123456789abcdef0123456789abcdef";

async function serve(t) {
  const directory = await mkdtemp(join(tmpdir(), "atlas-mission-http-"));
  const store = new LocalTaskStore(join(directory, "atlas.sqlite"));
  const missions = new Map();
  const events = new Map();
  const service = {
    list: () => [...missions.values()],
    create: (input) => {
      const mission = { id: "mission_1", status: "running", objective: input.objective };
      missions.set(mission.id, mission);
      events.set(mission.id, [
        { sequence: 1, kind: "mission.created", data: { status: mission.status } },
        { sequence: 2, kind: "mission.updated", data: { status: mission.status } },
      ]);
      return mission;
    },
    get: (id) => missions.get(id) ?? null,
    control: (id, action) => {
      const mission = missions.get(id);
      if (!mission) return null;
      mission.status = { pause: "paused", resume: "running", cancel: "cancelled" }[action];
      return mission;
    },
    subscribe: (id, after, listener) => {
      for (const event of events.get(id) ?? []) if (event.sequence > after) listener(event);
      return () => {};
    },
  };
  const server = createLocalControlServer({ store, token: TOKEN, runTask: async () => ({ ok: true }), missionService: service });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { origin: `http://127.0.0.1:${server.address().port}`, admin: { authorization: `Bearer ${TOKEN}` } };
}

async function pair(origin, admin) {
  const { code } = await (await fetch(`${origin}/v1/pair`, { method: "POST", headers: admin })).json();
  const { deviceToken } = await (await fetch(`${origin}/v1/pair/claim`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, name: "Phone" }),
  })).json();
  return { authorization: `Bearer ${deviceToken}` };
}

test("mission creation and controls are owner-only while paired devices can read", async (t) => {
  const { origin, admin } = await serve(t);
  const device = await pair(origin, admin);

  assert.equal((await fetch(`${origin}/v1/missions`, { method: "POST", headers: { ...device, "content-type": "application/json" }, body: "{}" })).status, 403);
  const created = await fetch(`${origin}/v1/missions`, {
    method: "POST",
    headers: { ...admin, "content-type": "application/json" },
    body: JSON.stringify({ objective: "Ship safely" }),
  });
  assert.equal(created.status, 201);
  assert.equal((await created.json()).mission.objective, "Ship safely");

  assert.equal((await fetch(`${origin}/v1/missions`, { headers: device })).status, 200);
  assert.equal((await fetch(`${origin}/v1/missions/mission_1`, { headers: device })).status, 200);
  assert.equal((await fetch(`${origin}/v1/missions/mission_1/control`, {
    method: "POST", headers: { ...device, "content-type": "application/json" }, body: JSON.stringify({ action: "cancel" }),
  })).status, 403);

  const paused = await fetch(`${origin}/v1/missions/mission_1/control`, {
    method: "POST", headers: { ...admin, "content-type": "application/json" }, body: JSON.stringify({ action: "pause" }),
  });
  assert.equal(paused.status, 200);
  assert.equal((await paused.json()).mission.status, "paused");
  assert.equal((await fetch(`${origin}/v1/missions/mission_1/control`, {
    method: "POST", headers: { ...admin, "content-type": "application/json" }, body: JSON.stringify({ action: "destroy" }),
  })).status, 400);
});

test("mission event streams are authenticated and honor replay cursors", async (t) => {
  const { origin, admin } = await serve(t);
  const device = await pair(origin, admin);
  await fetch(`${origin}/v1/missions`, {
    method: "POST", headers: { ...admin, "content-type": "application/json" }, body: JSON.stringify({ objective: "Observe" }),
  });
  assert.equal((await fetch(`${origin}/v1/missions/mission_1/events`)).status, 401);

  const replay = await fetch(`${origin}/v1/missions/mission_1/events?after=1`, { headers: device });
  assert.equal(replay.status, 200);
  assert.match(replay.headers.get("content-type"), /text\/event-stream/u);
  const reader = replay.body.getReader();
  const decoder = new TextDecoder();
  let streamed = "";
  while (!streamed.includes("id: 2")) streamed += decoder.decode((await reader.read()).value);
  assert.match(streamed, /retry: 2000/u);
  assert.doesNotMatch(streamed, /id: 1\n/u);
  assert.match(streamed, /id: 2/u);
  assert.match(streamed, /event: mission.updated/u);
  await reader.cancel();
});

test("mission JSON is bounded and an unattached service reports unavailable", async (t) => {
  const attached = await serve(t);
  const invalid = await fetch(`${attached.origin}/v1/missions`, {
    method: "POST", headers: { ...attached.admin, "content-type": "application/json" }, body: "[]",
  });
  assert.equal(invalid.status, 400);
  const large = await fetch(`${attached.origin}/v1/missions`, {
    method: "POST", headers: { ...attached.admin, "content-type": "application/json" }, body: JSON.stringify({ value: "x".repeat(256 * 1024) }),
  });
  assert.equal(large.status, 413);

  const directory = await mkdtemp(join(tmpdir(), "atlas-no-missions-"));
  const store = new LocalTaskStore(join(directory, "atlas.sqlite"));
  const server = createLocalControlServer({ store, token: TOKEN, runTask: async () => ({ ok: true }) });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { await new Promise((resolve) => server.close(resolve)); store.close(); await rm(directory, { recursive: true, force: true }); });
  const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/missions`, { headers: attached.admin });
  assert.equal(response.status, 503);
});
