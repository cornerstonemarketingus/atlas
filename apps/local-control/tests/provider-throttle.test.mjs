import assert from "node:assert/strict";
import test from "node:test";

import { MissionScheduler } from "../src/agent/mission-scheduler.mjs";
import { AdaptiveBatchSize, DEFAULT_BATCH_SIZE, classifyRateLimit, parseResetPhrase } from "../src/agent/provider-throttle.mjs";

const NOW = Date.UTC(2026, 8, 26, 3, 20);
const plan = (ids) => ({ id: "batch", title: "Batch", children: ids.map((id) => ({ id, objective: id, dependencies: [] })) });
const tick = () => new Promise((resolve) => setImmediate(resolve));

/** Manual clock and timers, so a provider reset hours away is one call. */
function fakeTime(start = NOW) {
  let now = start;
  const timers = new Map();
  let nextId = 1;
  return {
    clock: () => now,
    setTimer: (fn, delay) => { const id = nextId++; timers.set(id, { fn, at: now + delay }); return id; },
    clearTimer: (id) => { timers.delete(id); },
    advanceTo(at) {
      now = at;
      for (const [id, timer] of [...timers]) {
        if (timer.at <= now) { timers.delete(id); timer.fn(); }
      }
    },
  };
}

test("rate limits are recognized from status, code, and provider wording, and ordinary failures are not", () => {
  assert.equal(classifyRateLimit({ status: 429 }, { now: NOW }).rateLimited, true);
  assert.equal(classifyRateLimit({ code: "rate_limited" }, { now: NOW }).rateLimited, true);
  assert.equal(classifyRateLimit({ summary: "API error: You've hit your session limit · resets 6:10am (UTC)" }, { now: NOW }).rateLimited, true);
  assert.equal(classifyRateLimit({ message: "Too Many Requests" }, { now: NOW }).rateLimited, true);
  assert.equal(classifyRateLimit({ summary: "Tests failed: 3 of 40" }, { now: NOW }).rateLimited, false);
  assert.equal(classifyRateLimit(null).rateLimited, false);
});

test("the retry time comes from retry-after, then the reset phrase, then a doubling backoff", () => {
  assert.equal(classifyRateLimit({ status: 429, retryAfterSeconds: 30 }, { now: NOW }).retryAt, NOW + 30_000);
  assert.equal(classifyRateLimit({ status: 429, headers: { "retry-after": "120" } }, { now: NOW }).retryAt, NOW + 120_000);

  const phrase = classifyRateLimit({ summary: "You've hit your session limit · resets 6:10am (UTC)" }, { now: NOW });
  assert.equal(phrase.source, "reset-phrase");
  assert.equal(new Date(phrase.retryAt).toISOString(), "2026-09-26T06:10:00.000Z");

  const first = classifyRateLimit({ status: 429 }, { now: NOW, consecutive: 0 });
  const third = classifyRateLimit({ status: 429 }, { now: NOW, consecutive: 2 });
  assert.equal(first.source, "backoff");
  assert.equal(third.retryAt - NOW, 4 * (first.retryAt - NOW));
  assert.ok(classifyRateLimit({ status: 429 }, { now: NOW, consecutive: 50 }).retryAt - NOW <= 30 * 60_000, "backoff is capped");
});

test("reset phrases: past times roll to tomorrow, dated resets are honored, and nonsense is ignored", () => {
  assert.equal(new Date(parseResetPhrase("resets 1am (UTC)", NOW)).toISOString(), "2026-09-27T01:00:00.000Z");
  assert.equal(new Date(parseResetPhrase("resets Sep 27, 6pm (UTC)", NOW)).toISOString(), "2026-09-27T18:00:00.000Z");
  assert.equal(parseResetPhrase("resets 25:99", NOW), null);
  assert.equal(parseResetPhrase("resets Dec 25, 6pm", NOW), null, "more than a week out is treated as a misread");
  assert.equal(parseResetPhrase("no reset here", NOW), null);
});

test("the batch size halves on a limit, never drops below one, and grows back after clean runs", () => {
  const batch = new AdaptiveBatchSize({ max: 4, growAfter: 2 });
  assert.equal(batch.current, 4);
  assert.equal(batch.rateLimited(), 2);
  assert.equal(batch.rateLimited(), 1);
  assert.equal(batch.rateLimited(), 1);
  batch.succeeded();
  assert.equal(batch.succeeded(), 2);
  batch.succeeded(); batch.succeeded(); batch.succeeded(); batch.succeeded();
  assert.equal(batch.current, 4, "never grows past the configured maximum");
  assert.equal(DEFAULT_BATCH_SIZE, 3);
});

test("a rate-limited child is requeued, launches pause until the reset, and the mission completes", async () => {
  const time = fakeTime();
  const calls = [];
  let limited = false;
  const scheduler = new MissionScheduler({
    plan: plan(["a", "b", "c", "d"]),
    maxConcurrency: 2,
    clock: time.clock,
    setTimer: time.setTimer,
    clearTimer: time.clearTimer,
    execute: async ({ child }) => {
      calls.push(child.id);
      if (child.id === "a" && !limited) {
        limited = true;
        return { status: "failed", summary: "API error: You've hit your session limit · resets 6:10am (UTC)" };
      }
      return { summary: `${child.id} done` };
    },
  });

  const finished = scheduler.start();
  for (let i = 0; i < 10; i += 1) await tick();

  const waiting = scheduler.snapshot();
  assert.equal(waiting.status, "running", "a rate limit does not fail the mission");
  assert.equal(waiting.throttle.waitingUntil, "2026-09-26T06:10:00.000Z");
  assert.equal(waiting.throttle.batchSize, 1, "the batch halved from 2 to 1");
  const a = waiting.children.find((item) => item.id === "a");
  assert.equal(a.state, "pending");
  assert.equal(a.error.code, "RATE_LIMITED");
  assert.equal(a.rateLimits, 1);
  const launchedBeforeReset = calls.length;
  assert.ok(waiting.children.some((item) => item.state === "pending" && item.id !== "a"), "nothing new launched while throttled");

  time.advanceTo(Date.UTC(2026, 8, 26, 6, 10));
  const done = await finished;
  assert.equal(done.status, "completed");
  assert.ok(done.children.every((item) => item.state === "completed"));
  assert.ok(calls.length > launchedBeforeReset);
  assert.equal(calls.filter((id) => id === "a").length, 2, "the limited child ran again after the reset");
  assert.equal(done.throttle.waitingUntil, null);
});

test("a thrown 429 is requeued the same way as a failed result", async () => {
  const time = fakeTime();
  let first = true;
  const scheduler = new MissionScheduler({
    plan: plan(["only"]),
    maxConcurrency: 3,
    clock: time.clock,
    setTimer: time.setTimer,
    clearTimer: time.clearTimer,
    execute: async () => {
      if (first) { first = false; throw Object.assign(new Error("Too Many Requests"), { status: 429, retryAfterSeconds: 90 }); }
      return { summary: "ok" };
    },
  });
  const finished = scheduler.start();
  for (let i = 0; i < 5; i += 1) await tick();
  assert.equal(scheduler.snapshot().throttle.waitingUntil, new Date(NOW + 90_000).toISOString());
  time.advanceTo(NOW + 90_000);
  assert.equal((await finished).status, "completed");
});

test("a child that is rate limited past its retry allowance fails instead of looping forever", async () => {
  const time = fakeTime();
  const scheduler = new MissionScheduler({
    plan: plan(["stuck"]),
    maxConcurrency: 1,
    maxRateLimitRetries: 2,
    clock: time.clock,
    setTimer: time.setTimer,
    clearTimer: time.clearTimer,
    execute: async () => ({ status: "failed", code: "RATE_LIMITED", summary: "rate limited" }),
  });
  const finished = scheduler.start();
  for (let round = 0; round < 3; round += 1) {
    for (let i = 0; i < 5; i += 1) await tick();
    const until = scheduler.snapshot().throttle.waitingUntil;
    if (until) time.advanceTo(Date.parse(until));
  }
  const done = await finished;
  assert.equal(done.status, "failed");
  const stuck = done.children[0];
  assert.equal(stuck.state, "failed");
  assert.equal(stuck.error.code, "RATE_LIMITED");
  assert.equal(stuck.rateLimits, 3);
});

test("ordinary child failures still fail and do not throttle the mission", async () => {
  const scheduler = new MissionScheduler({
    plan: plan(["bad"]),
    maxConcurrency: 2,
    execute: async () => ({ status: "failed", summary: "Tests failed: 3 of 40" }),
  });
  const done = await scheduler.start();
  assert.equal(done.status, "failed");
  assert.equal(done.children[0].error.code, "CHILD_FAILED");
  assert.equal(done.throttle.waitingUntil, null);
  assert.equal(done.throttle.batchSize, 2);
});

test("cancelling a throttled mission clears the wait and cancels queued children", async () => {
  const time = fakeTime();
  const scheduler = new MissionScheduler({
    plan: plan(["a", "b"]),
    maxConcurrency: 1,
    clock: time.clock,
    setTimer: time.setTimer,
    clearTimer: time.clearTimer,
    execute: async () => ({ status: "failed", status_code: 429, code: "RATE_LIMITED", summary: "limited" }),
  });
  const finished = scheduler.start();
  for (let i = 0; i < 5; i += 1) await tick();
  assert.ok(scheduler.snapshot().throttle.waitingUntil);
  scheduler.cancel("Operator stopped it.");
  const done = await finished;
  assert.equal(done.status, "cancelled");
  assert.equal(done.throttle.waitingUntil, null);
  assert.ok(done.children.every((item) => item.state === "cancelled"));
});
