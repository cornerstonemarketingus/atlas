import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { decryptBackup, encryptBackup } from "../src/encrypted-backup.mjs";
import { LocalTaskStore } from "../src/store.mjs";

async function fixture(t, name = "atlas-mission-store-") {
  const directory = await mkdtemp(join(tmpdir(), name));
  const filename = join(directory, "atlas.sqlite");
  const store = new LocalTaskStore(filename);
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, filename, store };
}

const runningSnapshot = () => ({
  schemaVersion: 1,
  status: "running",
  reason: null,
  children: [
    { id: "research", state: "completed", error: null },
    { id: "build", state: "running", error: null },
  ],
});

test("mission snapshots upsert durably and events form a cursor-addressable append-only ledger", async (t) => {
  const { store } = await fixture(t);
  const created = store.saveMission({ schemaVersion: 1, plan: { id: "launch" }, status: "pending" });
  const updated = store.saveMission({ ...runningSnapshot(), plan: { id: "launch" } });

  assert.equal(updated.id, "launch");
  assert.equal(updated.status, "running");
  assert.equal(updated.createdAt, created.createdAt, "upsert preserves mission creation time");
  assert.deepEqual(store.mission("launch").snapshot, { ...runningSnapshot(), plan: { id: "launch" } });

  const first = store.appendMissionEvent("launch", { type: "child.started", payload: { childId: "build" } });
  const second = store.appendMissionEvent("launch", { type: "tool.completed", payload: { ok: true } });
  assert.ok(second.sequence > first.sequence);
  assert.deepEqual(store.missionEvents("launch", { after: first.sequence }), [second]);
  assert.throws(() => store.appendMissionEvent({ missionId: "missing", type: "child.started", payload: {} }), /FOREIGN KEY/u);
});

test("opening the store interrupts running missions and children exactly once", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "atlas-mission-restart-"));
  const filename = join(directory, "atlas.sqlite");
  const first = new LocalTaskStore(filename);
  first.saveMissionSnapshot({ id: "launch", status: "running", snapshot: runningSnapshot() });
  first.close();

  const second = new LocalTaskStore(filename);
  const mission = second.missionSnapshot("launch");
  assert.equal(mission.status, "interrupted");
  assert.equal(mission.snapshot.status, "interrupted");
  assert.equal(mission.snapshot.children[0].state, "completed");
  assert.equal(mission.snapshot.children[1].state, "interrupted");
  assert.equal(mission.snapshot.children[1].error.code, "INTERRUPTED");
  assert.deepEqual(second.missionEvents("launch").map(({ type, payload }) => ({ type, payload })), [
    { type: "mission.interrupted", payload: { reason: "process_restart" } },
  ]);
  second.close();

  const third = new LocalTaskStore(filename);
  assert.equal(third.missionEvents("launch").length, 1, "an already interrupted mission is not marked twice");
  third.close();
  await rm(directory, { recursive: true, force: true });
  t.after(() => rm(directory, { recursive: true, force: true }));
});

test("version 2 backup data restores mission state and event order while version 1 remains accepted", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "atlas-mission-backup-"));
  const source = new LocalTaskStore(join(directory, "source.sqlite"));
  const target = new LocalTaskStore(join(directory, "target.sqlite"));
  const legacy = new LocalTaskStore(join(directory, "legacy.sqlite"));
  t.after(async () => { source.close(); target.close(); legacy.close(); await rm(directory, { recursive: true, force: true }); });

  source.saveMissionSnapshot({ id: "launch", status: "completed", snapshot: { schemaVersion: 1, status: "completed", result: { ok: true } } });
  source.appendMissionEvent({ missionId: "launch", type: "mission.created", payload: { source: "test" } });
  source.appendMissionEvent({ missionId: "launch", type: "mission.completed", payload: { ok: true } });
  const backup = decryptBackup(encryptBackup(source.snapshot(), "correct horse battery staple"), "correct horse battery staple");
  assert.equal(backup.version, 2);
  target.saveMissionSnapshot({ id: "existing", status: "completed", snapshot: { schemaVersion: 1, status: "completed" } });
  target.appendMissionEvent("existing", { type: "mission.completed", payload: {} });
  target.importSnapshot(backup);
  assert.deepEqual(target.missionSnapshot("launch").snapshot.result, { ok: true });
  assert.deepEqual(target.missionEvents("launch").map((event) => event.type), ["mission.created", "mission.completed"]);
  assert.equal(target.missionEvents("existing").length, 1, "sequence collisions do not drop imported evidence");

  legacy.importSnapshot({ version: 1, exportedAt: new Date().toISOString(), tasks: [], policies: [], approvals: [], audit: [] });
  assert.deepEqual(legacy.missionSnapshots(), []);
});

test("mission persistence rejects malformed identifiers, non-JSON values, and oversized documents", async (t) => {
  const { store } = await fixture(t, "atlas-mission-bounds-");
  assert.throws(() => store.saveMissionSnapshot({ id: "Not Valid", status: "pending", snapshot: {} }), /mission id/u);
  assert.throws(() => store.saveMissionSnapshot({ id: "launch", status: "unknown", snapshot: {} }), /mission status/u);
  assert.throws(() => store.saveMissionSnapshot({ id: "launch", status: "pending", snapshot: { value: 1n } }), /JSON serializable/u);
  assert.throws(() => store.saveMissionSnapshot({ id: "launch", status: "pending", snapshot: { data: "x".repeat(1_048_576) } }), /exceeds 1048576 bytes/u);
  store.saveMissionSnapshot({ id: "launch", status: "pending", snapshot: {} });
  assert.throws(() => store.appendMissionEvent({ missionId: "launch", type: "BAD TYPE", payload: {} }), /event type/u);
  assert.throws(() => store.appendMissionEvent({ missionId: "launch", type: "trace", payload: { data: "x".repeat(262_144) } }), /exceeds 262144 bytes/u);
});
