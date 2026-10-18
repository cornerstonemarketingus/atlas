import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { getEventListeners } from "node:events";
import { UsageBudgetExceededError } from "../src/domain/usage-budget.js";
import { BudgetedModelProvider } from "../src/infrastructure/budgeted-model-provider.js";
import { InMemoryUsageBudgetLedger } from "../src/infrastructure/in-memory-usage-budget-ledger.js";
import { MockModelProvider } from "../src/infrastructure/mock-model-provider.js";
import { ModelProviderError, type ModelProvider, type ModelProviderMetadata, type ModelRequest, type ModelResponse } from "../src/model/model-provider.js";

const metadata: ModelProviderMetadata = {
  id: "mock",
  displayName: "Mock",
  models: [{
    model: "test",
    contextWindowTokens: 100,
    maxOutputTokens: 50,
    supportsTools: false,
    supportsJson: false,
    supportsStreaming: false,
  }],
};

function response(outputTokens: number): ModelResponse {
  return {
    id: "response",
    providerId: "mock",
    model: "test",
    message: { role: "assistant", content: [{ type: "text", text: "done" }] },
    finishReason: "stop",
    usage: { inputTokens: 3, outputTokens, totalTokens: 3 + outputTokens, estimatedCostUsd: 0.01 },
  };
}

test("caps requested output and records provider-reported usage", async () => {
  const mock = new MockModelProvider({ metadata, responses: [response(4)] });
  const ledger = new InMemoryUsageBudgetLedger({ outputTokens: 5, inputTokens: 10, costUsd: 1 });
  const provider = new BudgetedModelProvider(mock, ledger);

  await provider.complete({ model: "test", messages: [], maxOutputTokens: 20 });

  assert.equal(mock.requests[0]?.maxOutputTokens, 5);
  assert.equal(ledger.snapshot().used.outputTokens, 4);
  assert.equal(ledger.snapshot().used.inputTokens, 3);
});

test("rejects requests when no output-token budget remains", async () => {
  const mock = new MockModelProvider({ metadata, responses: [response(1)] });
  const ledger = new InMemoryUsageBudgetLedger({ outputTokens: 0 });
  const provider = new BudgetedModelProvider(mock, ledger);

  await assert.rejects(
    provider.complete({ model: "test", messages: [] }),
    (error: unknown) => error instanceof UsageBudgetExceededError,
  );
  assert.equal(mock.requests.length, 0);
});

test("directly nesting the same ledger fails before it can deadlock admission", () => {
  const ledger = new InMemoryUsageBudgetLedger({ outputTokens: 5 });
  const upstream = new MockModelProvider({ metadata, responses: [response(1)] });
  const first = new BudgetedModelProvider(upstream, ledger);
  assert.throws(() => new BudgetedModelProvider(first, ledger), TypeError);
});

test("two wrappers sharing a ledger admit HTTP requests against updated remaining tokens", async (t) => {
  const maxima: number[] = [];
  const server = createServer(async (request, reply) => {
    let body = "";
    for await (const chunk of request) body += String(chunk);
    const maximum = Number(JSON.parse(body).maxOutputTokens);
    maxima.push(maximum);
    reply.setHeader("content-type", "application/json");
    reply.end(JSON.stringify(response(Math.min(3, maximum))));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve()); server.closeAllConnections();
  }));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const upstream: ModelProvider = { metadata, async complete(request) {
    const result = await fetch(`http://127.0.0.1:${address.port}`, { method: "POST", body: JSON.stringify(request) });
    return await result.json() as ModelResponse;
  } };
  const ledger = new InMemoryUsageBudgetLedger({ outputTokens: 5 });
  const first = new BudgetedModelProvider(upstream, ledger);
  const second = new BudgetedModelProvider(upstream, ledger);
  await Promise.all([first.complete({ model: "test", messages: [] }), second.complete({ model: "test", messages: [] })]);
  assert.deepEqual(maxima, [5, 2]);
  assert.equal(ledger.snapshot().used.outputTokens, 5);
});

test("a failed attempt releases admission to the next wrapper", async () => {
  let calls = 0;
  const upstream: ModelProvider = { metadata, async complete() {
    if (++calls === 1) throw new Error("provider unavailable");
    return response(2);
  } };
  const ledger = new InMemoryUsageBudgetLedger({ outputTokens: 5 });
  const first = new BudgetedModelProvider(upstream, ledger);
  const second = new BudgetedModelProvider(upstream, ledger);
  const results = await Promise.allSettled([first.complete({ model: "test", messages: [] }), second.complete({ model: "test", messages: [] })]);
  assert.deepEqual(results.map((result) => result.status), ["rejected", "fulfilled"]);
  assert.equal(ledger.snapshot().used.outputTokens, 2);
});

test("a queued request never dispatches after the active call exhausts output", async () => {
  let calls = 0;
  const upstream: ModelProvider = { metadata, async complete() { calls++; return response(2); } };
  const ledger = new InMemoryUsageBudgetLedger({ outputTokens: 2 });
  const provider = new BudgetedModelProvider(upstream, ledger);
  const results = await Promise.allSettled([provider.complete({ model: "test", messages: [] }), provider.complete({ model: "test", messages: [] })]);
  assert.equal(results[0]?.status, "fulfilled");
  assert.ok(results[1]?.status === "rejected" && results[1].reason instanceof UsageBudgetExceededError);
  assert.equal(calls, 1);
  assert.equal(ledger.snapshot().used.outputTokens, 2);
});

test("failed response accounting blocks later calls on the same ledger", async () => {
  let calls = 0;
  const upstream: ModelProvider = { metadata, async complete() { calls++; return response(2); } };
  const ledger = new InMemoryUsageBudgetLedger({ outputTokens: 5, costUsd: 0 });
  const first = new BudgetedModelProvider(upstream, ledger);
  const second = new BudgetedModelProvider(upstream, ledger);
  const results = await Promise.allSettled([first.complete({ model: "test", messages: [] }), second.complete({ model: "test", messages: [] })]);
  for (const result of results) assert.ok(result.status === "rejected" && result.reason instanceof UsageBudgetExceededError);
  assert.equal(calls, 1);
  await assert.rejects(new BudgetedModelProvider(upstream, ledger).complete({ model: "test", messages: [] }), UsageBudgetExceededError);
  assert.equal(calls, 1);
});

test("queued cancellation is prompt and cannot let a later request bypass the active call", async () => {
  let release!: () => void;
  let started!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const entered = new Promise<void>((resolve) => { started = resolve; });
  const requests: ModelRequest[] = [];
  const upstream: ModelProvider = { metadata, async complete(request) {
    requests.push(request);
    if (requests.length === 1) { started(); await pending; }
    return response(2);
  } };
  const ledger = new InMemoryUsageBudgetLedger({ outputTokens: 5 });
  const provider = new BudgetedModelProvider(upstream, ledger);
  const active = provider.complete({ model: "test", messages: [] });
  await entered;
  const controller = new AbortController();
  const cancelled = provider.complete({ model: "test", messages: [] }, { signal: controller.signal });
  let later: Promise<ModelResponse> | undefined;
  controller.abort(new Error("private operator reason"));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      assert.rejects(cancelled, (error: unknown) => error instanceof ModelProviderError && error.code === "cancelled" && !error.message.includes("private")),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Queued cancellation did not settle")), 1000); }),
    ]);
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
    later = provider.complete({ model: "test", messages: [] });
    await Promise.resolve();
    assert.equal(requests.length, 1);
  } finally {
    clearTimeout(timer); release(); await Promise.allSettled([active, cancelled, ...(later ? [later] : [])]);
  }
  assert.deepEqual(requests.map((request) => request.maxOutputTokens), [5, 3]);
});

test("independent ledgers and unlimited output retain parallel execution", { timeout: 2000 }, async () => {
  for (const shared of [false, true]) {
    let release!: () => void;
    let started!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const entered = new Promise<void>((resolve) => { started = resolve; });
    const upstream: ModelProvider = { metadata, async complete(request) {
      if (request.model === "held") { started(); await pending; }
      return response(1);
    } };
    const ledger = new InMemoryUsageBudgetLedger(shared ? {} : { outputTokens: 5 });
    const first = new BudgetedModelProvider(upstream, ledger);
    const second = new BudgetedModelProvider(upstream, shared ? ledger : new InMemoryUsageBudgetLedger({ outputTokens: 5 }));
    const active = first.complete({ model: "held", messages: [] });
    await entered;
    try { await second.complete({ model: "test", messages: [] }); }
    finally { release(); await active; }
  }
});
