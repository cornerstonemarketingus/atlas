import assert from "node:assert/strict";
import test from "node:test";

import { ModelRequestError } from "../src/agent/model-client.mjs";
import { createRoutedClient } from "../src/agent/models/routed-client.mjs";

const collect = async (iterable) => { const out = []; for await (const chunk of iterable) out.push(chunk); return out; };

function fakeClients(behaviour) {
  const calls = [];
  return {
    calls,
    createClient: (route) => ({
      async *stream(request) {
        calls.push(`${route.endpoint}:${request.model}`);
        const mode = behaviour[route.model];
        if (mode === "down") throw new Error("connection refused");
        if (mode === "unauthorized") throw new ModelRequestError("MODEL_NOT_AUTHORIZED", "bad key");
        yield { type: "text", delta: `from ${route.model}` };
        if (mode === "midstream") throw new Error("connection reset");
        yield { type: "done", usage: {} };
      },
    }),
  };
}

const routes = [
  { task: "planning", model: "big", endpoint: "http://127.0.0.1:1" },
  { task: "planning", model: "small", endpoint: "http://127.0.0.1:2" },
  { task: "coding", model: "coder", endpoint: "http://127.0.0.1:3" },
];

test("an outage fails over to the next route and records which model answered", async () => {
  const { calls, createClient } = fakeClients({ big: "down", small: "ok" });
  const used = [];
  const client = createRoutedClient({ routes, createClient, fallback: null, onRoute: (route, info) => used.push([route.model, info.failedOver]) });
  const chunks = await collect(client.stream({ model: "big", messages: [] }));
  assert.equal(chunks[0].delta, "from small");
  assert.deepEqual(calls, ["http://127.0.0.1:1:big", "http://127.0.0.1:2:small"]);
  assert.deepEqual(used, [["small", true]]);
});

test("the session's chosen model is tried first", async () => {
  const { calls, createClient } = fakeClients({ big: "ok", small: "ok" });
  await collect(createRoutedClient({ routes, createClient, fallback: null }).stream({ model: "small", messages: [] }));
  assert.deepEqual(calls, ["http://127.0.0.1:2:small"]);
});

test("no failover after text reached the person, or on authorization errors", async () => {
  const mid = fakeClients({ big: "midstream", small: "ok" });
  await assert.rejects(collect(createRoutedClient({ routes, createClient: mid.createClient, fallback: null }).stream({ model: "big", messages: [] })), /connection reset/u);
  assert.equal(mid.calls.length, 1);
  const auth = fakeClients({ big: "unauthorized", small: "ok" });
  await assert.rejects(collect(createRoutedClient({ routes, createClient: auth.createClient, fallback: null }).stream({ model: "big", messages: [] })), (e) => e.code === "MODEL_NOT_AUTHORIZED");
  assert.equal(auth.calls.length, 1);
  const allDown = fakeClients({ big: "down", small: "down" });
  await assert.rejects(collect(createRoutedClient({ routes, createClient: allDown.createClient, fallback: null }).stream({ model: "big", messages: [] })), (e) => e.code === "NO_ROUTE" && /big: connection refused; small: connection refused/u.test(e.message));
});

test("with no routes for the task, the default client is used unchanged", () => {
  const fallback = { endpoint: "http://127.0.0.1:11434", stream: async function* () {} };
  assert.equal(createRoutedClient({ routes: [], createClient: () => null, fallback }), fallback);
  assert.equal(createRoutedClient({ routes: routes.filter((r) => r.task === "coding"), createClient: () => null, fallback }), fallback);
});
