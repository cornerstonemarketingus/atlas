import assert from "node:assert/strict";
import test from "node:test";
import { activityTaskStatus, pollActivity } from "../app/chat/activity-poll.mjs";

test("a hung response times out, reports unavailable, then recovers without overlapping requests", async () => {
  const unavailable = [], received = [];
  let calls = 0, firstSignal;
  let recovered;
  const recovery = new Promise(resolve => { recovered = resolve; });
  const stop = pollActivity({
    url: "/activity", intervalMs: 5, timeoutMs: 30,
    fetcher: async (_, { signal }) => {
      calls++;
      if (calls === 1) { firstSignal = signal; return new Promise(() => {}); }
      assert.equal(firstSignal.aborted, true);
      return { ok: true, json: async () => ({ status: "completed", conclusion: "success" }) };
    },
    onActivity: value => received.push(value),
    onUnavailable: value => { unavailable.push(value); if (!value) recovered(); },
  });
  try {
    await recovery;
    assert.deepEqual(unavailable, [true, false]);
    assert.equal(received[0].conclusion, "success");
    assert.equal(calls, 2);
  } finally { stop(); }
});

test("stopping polling aborts a request and suppresses late updates", async () => {
  let finish, signal;
  const updates = [];
  const stop = pollActivity({ url: "/activity", fetcher: (_, options) => {
    signal = options.signal;
    return new Promise(resolve => { finish = resolve; });
  }, onActivity: value => updates.push(value), onUnavailable: value => updates.push(value) });
  stop();
  finish({ ok: true, json: async () => ({ status: "in_progress" }) });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(signal.aborted, true);
  assert.deepEqual(updates, []);
});

test("an HTTP failure stays visible and terminal tasks fetch only once", async () => {
  let calls = 0;
  const values = [];
  const stop = pollActivity({ url: "/activity", repeat: false, intervalMs: 1,
    fetcher: async () => { calls++; return { ok: false }; },
    onActivity: () => assert.fail("an error must not replace the last activity"),
    onUnavailable: value => values.push(value),
  });
  await new Promise(resolve => setTimeout(resolve, 20));
  stop();
  assert.equal(calls, 1);
  assert.deepEqual(values, [true]);
});

test("completed activity overrides a stale running task status", () => {
  for (const [conclusion, expected] of [["success", "succeeded"], ["failure", "failed"], ["cancelled", "cancelled"], ["timed_out", "timed_out"]]) {
    assert.equal(activityTaskStatus({ status: "completed", conclusion }, "running"), expected);
  }
  assert.equal(activityTaskStatus({ status: "in_progress" }, "running"), "running");
  assert.equal(activityTaskStatus(null, "dispatched"), "dispatched");
});
