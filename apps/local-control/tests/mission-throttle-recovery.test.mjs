import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MissionScheduler } from "../src/agent/mission-scheduler.mjs";
import { MissionService } from "../src/agent/mission-service.mjs";
import { LocalTaskStore } from "../src/store.mjs";

const tick = () => new Promise(resolve => setImmediate(resolve));
function time() {
  let now = Date.now(), id = 0;
  const timers = new Map();
  return { clock: () => now, setTimer: (fn, ms) => { timers.set(++id, { fn, at: now + ms }); return id; }, clearTimer: id => timers.delete(id),
    advance(ms) { now += ms; for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.fn(); } },
  };
}
async function waiting({ retries = 2 } = {}) {
  const clock = time();
  const scheduler = new MissionScheduler({ ...clock, maxConcurrency: 4, maxRateLimitRetries: retries,
    plan: { id: "recovery", children: [{ id: "discover", objective: "Inspect files", dependencies: [] }, { id: "code", objective: "Edit and test", dependencies: ["discover"] }] },
    execute: async ({ child, budget }) => {
      budget.record({ toolCalls: 1 });
      return child.id === "discover" ? { summary: "Repository mapped" } : { status: "failed", code: "RATE_LIMITED", retryAfterSeconds: 60 };
    },
  });
  void scheduler.start();
  for (let i = 0; i < 8; i++) await tick();
  return { scheduler, clock, snapshot: JSON.parse(JSON.stringify(scheduler.snapshot())) };
}

test("restoration retains cooldown, reduced concurrency, evidence and budgets without replaying completed work", async () => {
  const { scheduler, clock, snapshot } = await waiting();
  scheduler.cancel();
  const ran = [];
  const restored = MissionScheduler.restore({ snapshot, ...clock, execute: async ({ child }) => { ran.push(child.id); return { summary: "verified" }; } });
  assert.equal(restored.status, "interrupted");
  assert.equal(restored.batchSize, 2);
  assert.equal(restored.snapshot().throttle.waitingUntil, snapshot.throttle.waitingUntil);
  assert.equal(restored.child("discover").result.summary, "Repository mapped");
  assert.equal(restored.child("code").usage.toolCalls, 1);
  const done = restored.start();
  await tick(); assert.deepEqual(ran, []);
  clock.advance(59_999); await tick(); assert.deepEqual(ran, []);
  clock.advance(1);
  assert.equal((await done).status, "completed");
  assert.deepEqual(ran, ["code"]);
  assert.equal(restored.child("code").attempts, 2);
});

test("pause/resume cannot bypass an outstanding provider reset", async () => {
  const { scheduler, clock, snapshot } = await waiting();
  scheduler.pause();
  assert.equal(scheduler.snapshot().throttle.waitingUntil, snapshot.throttle.waitingUntil);
  void scheduler.resume();
  await tick(); assert.equal(scheduler.child("code").attempts, 1);
  scheduler.cancel(); clock.advance(60_000);
  assert.equal(scheduler.status, "cancelled");
  assert.equal(scheduler.snapshot().throttle.waitingUntil, null);
});

test("restart preserves retry allowance and exponential-backoff progression", async () => {
  const { scheduler, clock, snapshot } = await waiting({ retries: 1 });
  scheduler.cancel();
  const restored = MissionScheduler.restore({ snapshot, ...clock, execute: async () => ({ status: "failed", code: "RATE_LIMITED" }) });
  const done = restored.start(); clock.advance(60_000);
  for (let i = 0; i < 8; i++) await tick();
  assert.equal(restored.status, "failed", "restart must not restore the default six retries");
  assert.equal((await done).children[1].rateLimits, 2);

  const retry = MissionScheduler.restore({ snapshot: { ...snapshot, maxRateLimitRetries: 3 }, ...clock, execute: async () => ({ status: "failed", code: "RATE_LIMITED" }) });
  void retry.start(); for (let i = 0; i < 8; i++) await tick();
  assert.equal(Date.parse(retry.snapshot().throttle.waitingUntil) - clock.clock(), 120_000);
  retry.cancel();
});

test("SQLite close/reopen and MissionService recovery preserve the wait until explicit resume", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "atlas-throttle-recovery-"));
  const { scheduler, snapshot } = await waiting(); scheduler.cancel();
  const path = join(directory, "state.sqlite");
  const first = new LocalTaskStore(path); first.saveMission(snapshot); first.close();
  const reopened = new LocalTaskStore(path);
  let calls = 0;
  const service = new MissionService({ store: reopened, execute: async () => { calls++; return { summary: "done" }; } });
  t.after(async () => { service.control("recovery", "cancel"); reopened.close(); await rm(directory, { recursive: true, force: true }); });
  service.recover();
  assert.equal(service.get("recovery").status, "interrupted");
  assert.equal(service.get("recovery").throttle.waitingUntil, snapshot.throttle.waitingUntil);
  await tick(); assert.equal(calls, 0);
  service.control("recovery", "resume");
  await tick(); assert.equal(calls, 0);
  assert.equal(reopened.mission("recovery").snapshot.children[0].result.summary, "Repository mapped");
});

test("legacy snapshots without throttle fields still restore and expired waits do not block", async () => {
  const { scheduler, clock, snapshot } = await waiting(); scheduler.cancel();
  clock.advance(60_001);
  for (const saved of [snapshot, { ...snapshot, throttle: undefined, maxRateLimitRetries: undefined }]) {
    const restored = MissionScheduler.restore({ snapshot: saved, ...clock, execute: async () => ({ summary: "done" }) });
    assert.equal((await restored.start()).status, "completed");
  }
});

test("a restored cooldown expiring does not resume a mission without operator action", async () => {
  const { scheduler, clock, snapshot } = await waiting(); scheduler.cancel();
  let calls = 0;
  const restored = MissionScheduler.restore({ snapshot, ...clock, execute: async () => { calls++; return { summary: "done" }; } });
  clock.advance(60_000); await tick();
  assert.equal(calls, 0); assert.equal(restored.status, "interrupted");
  assert.equal((await restored.start()).status, "completed");
  assert.equal(calls, 1);
});

test("malformed recovery fields are rejected instead of granting fresh retry capacity", async () => {
  const { scheduler, clock, snapshot } = await waiting(); scheduler.cancel();
  for (const patch of [{ maxRateLimitRetries: -1 }, { throttle: { batchSize: 0 } }, { throttle: { batchSize: 5 } }, { throttle: { consecutiveLimits: -1 } }, { throttle: { waitingUntil: "not-a-date" } }]) {
    assert.throws(() => MissionScheduler.restore({ snapshot: { ...snapshot, ...patch }, ...clock, execute: async () => ({}) }), error => error.code === "INVALID_SNAPSHOT");
  }
});
