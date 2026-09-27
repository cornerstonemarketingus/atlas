import assert from "node:assert/strict";
import test from "node:test";
import { InferenceGovernor, RateLimitState, WaitingForInferenceError } from "../src/index.mjs";

/** A clock that only moves when the governor sleeps, so tests are exact and instant. */
function world({ concurrency = 2, frozen = false } = {}) {
  let now = 0;
  const events = [];
  const capacity = new RateLimitState({ now: () => now });
  const governor = new InferenceGovernor({
    capacity, now: () => now, concurrencyPerTarget: concurrency,
    // Frozen: time never passes on its own, so only release() can move the queue.
    sleep: frozen ? () => new Promise(() => {}) : async (ms) => { now += ms; },
    onEvent: (type, data) => events.push({ type, ...data }),
  });
  return { governor, capacity, events, now: () => now, advance: (ms) => { now += ms; } };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("requests within concurrency are granted at once", async () => {
  const { governor } = world({ concurrency: 2 });
  const a = await governor.acquire({ targets: ["groq/big"] });
  const b = await governor.acquire({ targets: ["groq/big"] });
  assert.equal(a.key, "groq/big");
  assert.equal(b.waitedMs, 0);
  assert.deepEqual(governor.snapshot().inFlight, { "groq/big": 2 });
});

test("fourteen logical agents on two slots: all run, two at a time, none fails", async () => {
  const { governor } = world({ concurrency: 2 });
  let running = 0;
  let peak = 0;
  const agent = async () => {
    const lease = await governor.acquire({ targets: ["groq/big"], maxWaitMs: 600_000 });
    running += 1;
    peak = Math.max(peak, running);
    await tick();
    running -= 1;
    lease.release();
    return "done";
  };
  const results = await Promise.all(Array.from({ length: 14 }, agent));
  assert.equal(results.length, 14);
  assert.ok(results.every((result) => result === "done"));
  assert.equal(peak, 2);
});

test("with abundant capacity the same fourteen agents run together", async () => {
  const { governor } = world({ concurrency: 16 });
  let running = 0;
  let peak = 0;
  await Promise.all(Array.from({ length: 14 }, async () => {
    const lease = await governor.acquire({ targets: ["local/big"] });
    running += 1;
    peak = Math.max(peak, running);
    await tick();
    running -= 1;
    lease.release();
  }));
  assert.equal(peak, 14);
});

test("a target known to be refusing is queued behind its reset, then granted", async () => {
  const { governor, capacity, now, events } = world();
  capacity.rateLimited("groq/big", { retryAfterMs: 9_000 });
  const lease = await governor.acquire({ targets: ["groq/big"], maxWaitMs: 30_000 });
  assert.equal(lease.key, "groq/big");
  assert.ok(now() >= 9_000);
  assert.ok(events.some((event) => event.type === "inference.queued" && event.expectedWaitMs === 9_000));
});

test("a short wait for the preferred model beats switching to a weaker one", async () => {
  const { governor, capacity } = world();
  capacity.rateLimited("groq/big", { retryAfterMs: 3_000 });
  const lease = await governor.acquire({ targets: ["groq/big", "groq/small"], preferFirstWithinMs: 8_000 });
  assert.equal(lease.key, "groq/big");
});

test("a long wait for the preferred model routes to the next eligible target", async () => {
  const { governor, capacity, events } = world();
  capacity.rateLimited("groq/big", { retryAfterMs: 60_000 });
  const lease = await governor.acquire({ targets: ["groq/big", "local/qwen"], preferFirstWithinMs: 8_000 });
  assert.equal(lease.key, "local/qwen");
  assert.equal(lease.index, 1);
  assert.ok(events.some((event) => event.type === "inference.target_changed" && event.to === "local/qwen"));
});

test("when every target is out past the deadline, the work is handed back with when to resume", async () => {
  const { governor, capacity, events } = world();
  capacity.rateLimited("groq/big", { retryAfterMs: 120_000 });
  capacity.rateLimited("groq/small", { retryAfterMs: 90_000 });
  await assert.rejects(governor.acquire({ targets: ["groq/big", "groq/small"], maxWaitMs: 30_000 }), (error) => {
    assert.ok(error instanceof WaitingForInferenceError);
    assert.equal(error.code, "WAITING_FOR_INFERENCE");
    assert.equal(error.retryInMs, 90_000);
    return true;
  });
  assert.ok(events.some((event) => event.type === "inference.deferred"));
});

test("a request larger than every target's whole allowance is deferred as such, not waited on forever", async () => {
  const { governor, capacity } = world();
  capacity.observe("groq/big", new Headers({ "x-ratelimit-limit-tokens": "8000", "x-ratelimit-remaining-tokens": "100", "x-ratelimit-reset-tokens": "5s" }));
  await assert.rejects(governor.acquire({ targets: ["groq/big"], estimatedTokens: 20_000 }), (error) => error.reason === "larger_than_allowance");
});

test("higher priority waiters go first when a slot frees", async () => {
  const { governor } = world({ concurrency: 1 });
  const holder = await governor.acquire({ targets: ["t"] });
  const order = [];
  const low = governor.acquire({ targets: ["t"], priority: 0, maxWaitMs: 600_000 }).then((lease) => { order.push("child"); lease.release(); });
  const high = governor.acquire({ targets: ["t"], priority: 3, maxWaitMs: 600_000 }).then((lease) => { order.push("lead"); lease.release(); });
  await tick();
  holder.release();
  await Promise.all([low, high]);
  assert.deepEqual(order, ["lead", "child"]);
});

test("tokens in flight count, so parallel requests do not overrun what is left", async () => {
  const { governor, capacity } = world({ concurrency: 8, frozen: true });
  capacity.observe("t", new Headers({ "x-ratelimit-limit-tokens": "8000", "x-ratelimit-remaining-tokens": "7000", "x-ratelimit-reset-tokens": "10s" }));
  const a = await governor.acquire({ targets: ["t"], estimatedTokens: 5_000 });
  let secondGranted = false;
  const b = governor.acquire({ targets: ["t"], estimatedTokens: 5_000, maxWaitMs: 60_000 }).then((lease) => { secondGranted = true; return lease; });
  await tick();
  assert.equal(secondGranted, false, "5,000 in flight leaves 2,000");
  a.release();
  (await b).release();
  assert.equal(secondGranted, true);
});

test("cancelling a queued request removes it without granting", async () => {
  const { governor } = world({ concurrency: 1 });
  const holder = await governor.acquire({ targets: ["t"] });
  const controller = new AbortController();
  const queued = governor.acquire({ targets: ["t"], signal: controller.signal, maxWaitMs: 600_000 });
  controller.abort();
  await assert.rejects(queued, (error) => error.code === "CANCELLED");
  holder.release();
  assert.deepEqual(governor.snapshot(), { waiting: [], inFlight: {} });
});

test("release is idempotent and events carry no content", async () => {
  const { governor, events } = world();
  const lease = await governor.acquire({ targets: ["t"], role: "lead", taskId: "task-1" });
  lease.release();
  lease.release();
  assert.deepEqual(governor.snapshot().inFlight, {});
  assert.deepEqual(events.map((event) => event.type), ["inference.requested", "inference.started", "inference.completed"]);
  assert.ok(events.every((event) => event.role === "lead" && event.taskId === "task-1"));
});
