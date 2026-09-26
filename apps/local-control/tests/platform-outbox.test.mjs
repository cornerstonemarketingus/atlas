import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { PlatformTaskStore } from "../src/platform/task-store.mjs";
import { OutboxDispatcher, createEventStream } from "../src/platform/outbox-dispatcher.mjs";
import { LOCAL_TENANT_ID } from "../src/platform/dashboard.mjs";
import { createLocalControlServer } from "../src/server.mjs";
import { LocalTaskStore } from "../src/store.mjs";

const TOKEN = "0123456789abcdef0123456789abcdef";

async function fixture(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), "atlas-outbox-"));
  const store = new PlatformTaskStore(join(dir, "platform.sqlite"), options);
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
  const createTask = (objective = "Do a thing.") => store.createTask({ tenantId: LOCAL_TENANT_ID, userId: "owner", objective, successCriteria: ["done"] });
  return { store, createTask };
}

test("every committed event is delivered once to matching subscribers and acknowledged", async (t) => {
  const { store, createTask } = await fixture(t);
  const task = createTask();
  store.transitionTask(LOCAL_TENANT_ID, task.id, "authorized", { actor: "owner" });
  const all = [];
  const transitions = [];
  const dispatcher = new OutboxDispatcher({ store });
  dispatcher.subscribe("*", (event) => { all.push(event.type); });
  dispatcher.subscribe("task.transitioned", (event) => { transitions.push(event.payload); });
  const totals = await dispatcher.drain();
  assert.deepEqual(all, ["task.created", "task.transitioned"]);
  assert.equal(transitions.length, 1);
  assert.equal(totals.delivered, 2);
  assert.equal(store.listOutbox({ status: "delivered" }).length, 2);
  assert.equal((await dispatcher.drain()).delivered, 0, "nothing is delivered twice once acknowledged");
});

test("a failing subscriber causes a retry, then a visible dead letter", async (t) => {
  const { store, createTask } = await fixture(t, { maxOutboxAttempts: 2 });
  createTask();
  let calls = 0;
  const errors = [];
  const dispatcher = new OutboxDispatcher({ store, onError: (error) => errors.push(error.message) });
  dispatcher.subscribe("task.*", () => { calls += 1; throw new Error("subscriber down"); });
  assert.deepEqual(await dispatcher.drain(), { delivered: 0, retried: 1, deadLettered: 0 });
  assert.deepEqual(await dispatcher.drain(), { delivered: 0, retried: 0, deadLettered: 1 });
  assert.equal(calls, 2);
  const [dead] = store.listOutbox({ status: "dead" });
  assert.equal(dead.lastError, "subscriber down");
  assert.deepEqual(errors, ["subscriber down", "subscriber down"]);
});

test("the dashboard receives live events over the authenticated stream", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "atlas-stream-"));
  const store = new LocalTaskStore(join(dir, "atlas.sqlite"));
  const platformStore = new PlatformTaskStore(join(dir, "platform.sqlite"));
  const platformStream = createEventStream({ tenantFor: () => LOCAL_TENANT_ID });
  const dispatcher = new OutboxDispatcher({ store: platformStore, intervalMs: 20 });
  dispatcher.subscribe("*", (event) => platformStream.publish(event));
  dispatcher.start();
  const server = createLocalControlServer({ store, token: TOKEN, runTask: async () => ({ ok: true }), platformStore, platformStream });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const controller = new AbortController();
  t.after(async () => {
    controller.abort();
    await dispatcher.stop();
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    store.close();
    platformStore.close();
    await rm(dir, { recursive: true, force: true });
  });
  assert.equal((await fetch(`${origin}/v1/platform/stream`)).status, 401);
  const response = await fetch(`${origin}/v1/platform/stream`, { headers: { authorization: `Bearer ${TOKEN}` }, signal: controller.signal });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/event-stream/u);
  const reader = response.body.getReader();
  await reader.read(); // ": connected"
  const task = platformStore.createTask({ tenantId: LOCAL_TENANT_ID, userId: "owner", objective: "Stream me.", successCriteria: ["seen"] });
  let text = "";
  const deadline = Date.now() + 5000;
  while (!text.includes("event: task.created") && Date.now() < deadline) text += new TextDecoder().decode((await reader.read()).value);
  assert.match(text, /event: task\.created/u);
  assert.ok(text.includes(task.id));
  assert.equal(platformStream.size, 1);
});
