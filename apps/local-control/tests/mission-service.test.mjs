import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { MissionService, MissionServiceError } from "../src/agent/mission-service.mjs";
import { LocalTaskStore } from "../src/store.mjs";

async function fixture(t, execute) {
  const directory = await mkdtemp(join(tmpdir(), "atlas-mission-service-"));
  const store = new LocalTaskStore(join(directory, "atlas.sqlite"));
  const service = new MissionService({ store, execute });
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  return { store, service };
}

const input = () => ({
  id: "launch",
  title: "Launch safely",
  repository: "C:/work/atlas",
  model: "local-model",
  maxConcurrency: 2,
  children: [
    { id: "research", objective: "Map constraints", dependencies: [] },
    { id: "build", objective: "Implement", dependencies: ["research"] },
  ],
});

test("a mission executes its dependency graph and persists evidence and events", async (t) => {
  const executed = [];
  const { store, service } = await fixture(t, async ({ child, budget }) => {
    executed.push(child.id);
    budget.record({ outputTokens: 2 });
    return { summary: `${child.id} verified`, evidence: [{ kind: "receipt", name: child.id }] };
  });

  service.create(input());
  await waitFor(() => service.get("launch")?.status === "completed");
  const mission = service.get("launch");
  assert.deepEqual(executed, ["research", "build"]);
  assert.equal(mission.children[1].result.summary, "build verified");
  assert.equal(mission.children[1].usage.outputTokens, 2);
  assert.equal(store.mission("launch").snapshot.status, "completed");
  assert.ok(service.events("launch").some((event) => event.kind === "mission.created"));
  assert.ok(service.events("launch").some((event) => event.status === "completed"));
});

test("mission creation requires an execution target and rejects duplicate ids", async (t) => {
  const { service } = await fixture(t, async () => ({ summary: "done" }));
  assert.throws(() => service.create({ ...input(), repository: "" }), (error) => error instanceof MissionServiceError && error.code === "INVALID_MISSION");
  service.create(input());
  assert.throws(() => service.create(input()), (error) => error.code === "MISSION_EXISTS");
  assert.throws(() => service.control("missing", "cancel"), (error) => error.code === "UNKNOWN_MISSION");
});

test("restart recovery stays interrupted until the operator explicitly resumes", async (t) => {
  const { store, service } = await fixture(t, async () => ({ summary: "done" }));
  const snapshot = {
    schemaVersion: 1,
    plan: { id: "recover", title: "Recover", children: [{ id: "child", order: 0, objective: "Resume", dependencies: [], resourceLocks: [], budget: { inputTokens: 100, outputTokens: 100, toolCalls: 2, elapsedMs: 1000, costMicroUsd: 0 }, metadata: { repository: "C:/work/atlas", model: "local" } }] },
    maxConcurrency: 1,
    status: "running",
    reason: null,
    startedAt: new Date().toISOString(),
    completedAt: null,
    children: [{ id: "child", order: 0, objective: "Resume", dependencies: [], resourceLocks: [], budget: { inputTokens: 100, outputTokens: 100, toolCalls: 2, elapsedMs: 1000, costMicroUsd: 0 }, metadata: { repository: "C:/work/atlas", model: "local" }, state: "running", attempts: 1, usage: { inputTokens: 0, outputTokens: 0, toolCalls: 0, elapsedMs: 5, costMicroUsd: 0 }, startedAt: new Date().toISOString(), completedAt: null, result: null, error: null }],
  };
  store.saveMission(snapshot);

  // Simulate the store-open reconciliation without starting a second owner of
  // this fixture: persist the interrupted shape the store exposes on restart.
  snapshot.status = "interrupted";
  snapshot.children[0].state = "interrupted";
  store.saveMission(snapshot);
  const recovered = service.recover();
  assert.equal(recovered[0].status, "interrupted");
  assert.equal(service.get("recover").status, "interrupted");
  assert.ok(service.events("recover").some((event) => event.kind === "mission.recovered"));
});

async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for mission state.");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
