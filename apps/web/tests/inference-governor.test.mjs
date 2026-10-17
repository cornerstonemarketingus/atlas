import assert from "node:assert/strict";
import test from "node:test";
import { createGovernorCore, handleGovernorRequest } from "../worker/inference-governor-core.mjs";
import { InferenceGovernorObject } from "../worker/inference-governor.mjs";
import { governorCall, governorFor, governorReadiness, quotaScopeFor } from "../app/api/inference/governor-client.mjs";

/** Durable Object storage, as far as the governor uses it: JSON-cloned values and one alarm. */
function fakeStorage() {
  const values = new Map();
  const alarms = [];
  return {
    alarms,
    async get(key) { return values.has(key) ? structuredClone(values.get(key)) : undefined; },
    async put(key, value) { values.set(key, structuredClone(value)); },
    async setAlarm(at) { alarms.push(at); },
  };
}
const headers = (remaining) => ({ "x-ratelimit-limit-tokens": "6000", "x-ratelimit-remaining-tokens": String(remaining), "x-ratelimit-reset-tokens": "30s" });

test("reservations are shared by every caller of one scope and survive a restart", async () => {
  let now = 0;
  const storage = fakeStorage();
  const governor = createGovernorCore({ storage, now: () => now });
  await governor.observe({ model: "big", headers: headers(5000) });
  assert.equal((await governor.reserve({ requestId: "isolate-a", models: ["big"], estimatedTokens: 3000 })).granted, true);
  // The object is evicted and recreated: the ledger comes back from storage.
  const restarted = createGovernorCore({ storage, now: () => now });
  const second = await restarted.reserve({ requestId: "isolate-b", models: ["big"], estimatedTokens: 3000 });
  assert.equal(second.granted, false);
  assert.equal((await restarted.reserve({ requestId: "isolate-a", models: ["big"], estimatedTokens: 3000 })).replay, true);
  now = 1;
  await restarted.release({ requestId: "isolate-a", headers: headers(4800) });
  assert.equal((await restarted.reserve({ requestId: "isolate-b", models: ["big"], estimatedTokens: 3000 })).granted, true);
});

test("an alarm is set for the earliest expiry, and running it more than once is harmless", async () => {
  let now = 0;
  const storage = fakeStorage();
  const governor = createGovernorCore({ storage, now: () => now });
  await governor.reserve({ requestId: "r", models: ["big"], estimatedTokens: 1, ttlMs: 30_000 });
  assert.equal(storage.alarms.at(-1), 30_000);
  now = 30_001;
  await governor.alarm();
  await governor.alarm();
  assert.equal((await governor.snapshot()).reservations, 0);
});

test("a 429 reported on release blocks the model for every caller", async () => {
  const storage = fakeStorage();
  const governor = createGovernorCore({ storage, now: () => 0 });
  await governor.reserve({ requestId: "r", models: ["big"], estimatedTokens: 1 });
  await governor.release({ requestId: "r", status: 429, retryAfterMs: 20_000 });
  const denied = await governor.reserve({ requestId: "s", models: ["big"], estimatedTokens: 1 });
  assert.deepEqual([denied.granted, denied.waitMs], [false, 20_000]);
});

test("one key is one scope wherever it is used; the scope never contains the key", async () => {
  const endpoint = { baseUrl: "https://api.groq.com/openai/v1/", apiKey: "gsk_live_secret_value" };
  const scope = await quotaScopeFor(endpoint);
  assert.equal(scope, await quotaScopeFor({ ...endpoint, baseUrl: "https://api.groq.com/other/path" }));
  assert.notEqual(scope, await quotaScopeFor({ ...endpoint, apiKey: "gsk_other" }));
  assert.match(scope, /^https:\/\/api\.groq\.com#[0-9a-f]{16}$/u);
  assert.doesNotMatch(scope, /secret/u);
  assert.equal(await quotaScopeFor({ baseUrl: "http://127.0.0.1:11434/v1" }), "http://127.0.0.1:11434");
});

test("the governor never becomes the reason a reply fails", async () => {
  assert.equal(governorFor("scope", {}), null, "no binding: no governor");
  assert.equal(await governorCall(null, "reserve", {}), null);
  const logged = [];
  const original = console.warn;
  console.warn = (line) => logged.push(String(line));
  try {
    const broken = { fetch: async () => { throw new TypeError("network lost gsk_live_secret"); } };
    assert.equal(await governorCall(broken, "reserve", { requestId: "r" }), null);
  } finally {
    console.warn = original;
  }
  assert.match(logged[0], /inference\.governor_unavailable/u);
  assert.doesNotMatch(logged.join(""), /gsk_live_secret/u, "the error message is not logged, only its kind");
});

test("setup readiness reports counts only", async () => {
  assert.deepEqual(await governorReadiness({ configured: true, baseUrl: "https://api.groq.com/openai/v1", apiKey: "k" }, {}), { bound: false });
  const storage = fakeStorage();
  const core = createGovernorCore({ storage, now: () => 0 });
  const namespace = { idFromName: (name) => name, get: () => ({ fetch: (request) => handleGovernorRequest(core, request) }) };
  assert.deepEqual(await governorReadiness({ configured: false }, { INFERENCE_GOVERNOR: namespace }), { bound: true, reachable: null });
  const ready = await governorReadiness({ configured: true, baseUrl: "https://api.groq.com/openai/v1", apiKey: "k" }, { INFERENCE_GOVERNOR: namespace });
  assert.deepEqual(ready, { bound: true, reachable: true, models: 0, reservations: 0, waiting: 0 });
});

test("the Durable Object speaks the governor protocol and rejects anything else", async () => {
  const storage = fakeStorage();
  const object = new InferenceGovernorObject({ storage });
  const call = (method, body, init = {}) => object.fetch(new Request(`https://inference-governor/${method}`, { method: "POST", body: JSON.stringify(body), ...init }));
  const granted = await (await call("reserve", { requestId: "r", models: ["big"], estimatedTokens: 10 })).json();
  assert.equal(granted.granted, true);
  assert.equal((await call("delete-everything", {})).status, 404);
  assert.equal((await object.fetch(new Request("https://inference-governor/reserve"))).status, 404, "GET is not an operation");
  assert.equal((await object.fetch(new Request("https://inference-governor/reserve", { method: "POST", body: "{" }))).status, 400);
  await object.alarm();
});
