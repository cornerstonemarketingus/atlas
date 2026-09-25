import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { defineTool } from "../../../packages/atlas-contracts/src/index.mjs";
import { AuthorizedToolExecutor, PlatformTaskStore, PolicyEngine } from "../src/platform/index.mjs";
import { LOCAL_TENANT_ID } from "../src/platform/dashboard.mjs";
import { createLocalControlServer } from "../src/server.mjs";
import { LocalTaskStore } from "../src/store.mjs";

const TOKEN = "0123456789abcdef0123456789abcdef";

async function harness(t, { platform = true } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "atlas-dashboard-"));
  const store = new LocalTaskStore(join(directory, "atlas.sqlite"));
  const platformStore = platform ? new PlatformTaskStore(join(directory, "platform.sqlite")) : null;
  const server = createLocalControlServer({ store, token: TOKEN, runTask: async () => ({ ok: true, message: "ok" }), platformStore });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    store.close();
    platformStore?.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { origin: `http://127.0.0.1:${server.address().port}`, platformStore };
}

/** Runs one real task through the executor so the dashboard has a full story to show. */
async function seedTask(store) {
  const executor = new AuthorizedToolExecutor({ store, policy: new PolicyEngine({ version: "dash.1", rules: [] }) });
  executor.register(defineTool({
    name: "demo.read_value", description: "Return a fixed value.", risk: "read",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    execute: async () => ({ output: { value: "42" }, evidence: [{ kind: "fixture" }] }),
  }));
  const task = store.createTask({
    tenantId: LOCAL_TENANT_ID, userId: "owner", agentId: "agent-1", objective: "Read the demo value.",
    successCriteria: ["value is 42"], budget: { toolCalls: 5 },
  });
  for (const to of ["authorized", "queued", "running"]) store.transitionTask(LOCAL_TENANT_ID, task.id, to, { reason: to, actor: "owner" });
  await executor.invoke({ tenantId: LOCAL_TENANT_ID, userId: "owner", agentId: "agent-1", taskId: task.id, tool: "demo.read_value", input: {}, grantedPermissions: ["demo.*"] });
  const artifact = store.submitArtifact({ tenantId: LOCAL_TENANT_ID, taskId: task.id, kind: "value", content: { value: "42" } });
  store.markArtifactVerified(LOCAL_TENANT_ID, artifact.id, { verified: true, evidence: [{ check: "equals", ok: true }] });
  // Another tenant's task must never appear on the local dashboard.
  store.createTask({ tenantId: "someone-else", userId: "u", objective: "Hidden.", successCriteria: ["x"], budget: {} });
  return task;
}

test("the dashboard page is served without data, and its data needs the local token", async (t) => {
  const { origin } = await harness(t);
  const page = await fetch(`${origin}/platform`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Atlas Tasks/u);
  assert.match(page.headers.get("content-security-policy"), /script-src 'self'/u);
  assert.equal((await fetch(`${origin}/platform.js`)).status, 200);
  assert.equal((await fetch(`${origin}/v1/platform/tasks`)).status, 401);
});

test("the dashboard lists tasks and shows status, tool calls with decisions, artifacts and events", async (t) => {
  const { origin, platformStore } = await harness(t);
  const task = await seedTask(platformStore);
  const headers = { authorization: `Bearer ${TOKEN}` };

  const list = await (await fetch(`${origin}/v1/platform/tasks`, { headers })).json();
  assert.deepEqual(list.tasks.map((row) => row.id), [task.id]);
  assert.equal(list.tasks[0].toolCalls, 1);

  const detail = await (await fetch(`${origin}/v1/platform/tasks/${task.id}`, { headers })).json();
  assert.equal(detail.task.status, "running");
  assert.deepEqual(detail.transitions.map((row) => row.to), ["authorized", "queued", "running"]);
  assert.equal(detail.toolCalls[0].tool, "demo.read_value");
  assert.equal(detail.toolCalls[0].status, "succeeded");
  assert.equal(detail.toolCalls[0].decision.effect, "allow");
  assert.equal(detail.artifacts[0].verification, "verified");
  assert.ok(detail.events.every((event) => event.correlationId === task.correlationId));

  assert.equal((await fetch(`${origin}/v1/platform/tasks/tsk_${"0".repeat(32)}`, { headers })).status, 404);
  assert.equal((await fetch(`${origin}/v1/platform/tasks/${task.id}`, { method: "DELETE", headers })).status, 405);
});

test("without a platform store the routes say so instead of pretending to be empty", async (t) => {
  const { origin } = await harness(t, { platform: false });
  const response = await fetch(`${origin}/v1/platform/tasks`, { headers: { authorization: `Bearer ${TOKEN}` } });
  assert.equal(response.status, 503);
});
