import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalControlServer } from "../src/server.mjs";
import { LocalTaskStore } from "../src/store.mjs";
import { PlatformTaskStore } from "../src/platform/task-store.mjs";
import { createWorkforceRuntime } from "../src/platform/workforce-runtime.mjs";

test("authenticated HTTP intake runs a workforce and exposes reviewed evidence through the platform dashboard", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "atlas-workforce-http-"));
  writeFileSync(join(directory, "evidence.txt"), "evidence");
  const store = new LocalTaskStore(join(directory, "local.sqlite"));
  const platformStore = new PlatformTaskStore(join(directory, "platform.sqlite"));
  const runtime = createWorkforceRuntime({ store: platformStore, dataDirectory: directory, repository: directory,
    model: "test-model", endpoint: "http://127.0.0.1:11434/v1" });
  const token = "a".repeat(32);
  const server = createLocalControlServer({ store, token, runTask: async () => ({}), platformStore, workforceRuntime: runtime });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    runtime.close(); platformStore.close(); store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  assert.equal((await fetch(`${url}/v1/workforce`)).status, 401);
  const overview = await (await fetch(`${url}/v1/workforce`, { headers })).json();
  assert.ok(overview.tools.some((tool) => tool.name === "repository.read"));
  const response = await fetch(`${url}/v1/workforce/runs`, { method: "POST", headers, body: JSON.stringify({
    tenantId: "forged", ownerAgentId: overview.rootId, reviewerAgentId: overview.agents["Quality Reviewer"],
    objective: "Read the repository evidence.", budget: { toolCalls: 2, wallTimeMs: 30_000 },
    steps: [{ agentId: overview.agents["Engineering Worker"], calls: [{ tool: "repository.read", input: { path: "evidence.txt" }, outputSchema: { type: "string", const: "1\tevidence" } }] }],
  }) });
  assert.equal(response.status, 202);
  const { taskId } = await response.json();
  let run;
  for (let attempt = 0; attempt < 100; attempt++) {
    ({ run } = await (await fetch(`${url}/v1/workforce/runs/${taskId}`, { headers })).json());
    if (run.status !== "running" && run.status !== "queued") break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(run.status, "completed", run.error);
  assert.equal(run.tenantId, "local");
  const child = run.steps[0];
  const dashboard = await (await fetch(`${url}/v1/platform/tasks/${child.taskId}`, { headers })).json();
  assert.equal(dashboard.task.status, "completed");
  assert.equal(dashboard.artifacts[0].verification, "verified");
  assert.equal(dashboard.toolCalls.length, 1);
});
