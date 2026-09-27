import assert from "node:assert/strict";
import test from "node:test";
import { callModel } from "../app/api/chat/agent-loop.mjs";

for (const scenario of [
  { name: "recovers after a short fallback rate limit", statuses: [429, 429, 200], delays: [60, 1], models: ["primary", "fallback", "fallback"], waits: [1000], status: 200 },
  { name: "stops after one retry per model", statuses: [429, 429, 429, 429], delays: [1, 1, 1, 1], models: ["primary", "primary", "fallback", "fallback"], waits: [1000, 1000], status: 429 },
  { name: "does not wait out a long fallback quota", statuses: [429, 429], delays: [60, 60], models: ["primary", "fallback"], waits: [], status: 429 },
  { name: "does not retry a non-rate-limit fallback error", statuses: [429, 401], delays: [60], models: ["primary", "fallback"], waits: [], status: 401 },
  { name: "does not repeat the primary as its own fallback", fallbackModel: "primary", statuses: [429, 429], delays: [1, 1], models: ["primary", "primary"], waits: [1000], status: 429 },
]) {
  test(scenario.name, async () => {
    const models = [];
    const waits = [];
    const response = await callModel({ baseUrl: "https://model.test/v1/", model: "primary", fallbackModel: scenario.fallbackModel ?? "fallback" }, [{ role: "user", content: "hi" }], {
      stream: false,
      sleep: async (ms) => { waits.push(ms); },
      fetcher: async (_url, init) => {
        const index = models.length;
        models.push(JSON.parse(init.body).model);
        assert.ok(index < scenario.statuses.length, "unexpected extra model request");
        return new Response("", { status: scenario.statuses[index], headers: { "retry-after": String(scenario.delays[index] ?? 0) } });
      },
    });
    assert.equal(response.status, scenario.status);
    assert.deepEqual(models, scenario.models);
    assert.deepEqual(waits, scenario.waits);
  });
}
