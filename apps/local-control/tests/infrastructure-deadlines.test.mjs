import assert from "node:assert/strict";
import test from "node:test";
import { getEventListeners } from "node:events";
import { createApiClient } from "../src/agent/infrastructure/adapter.mjs";

for (const phase of ["headers", "body"]) {
  test(`hosting deadline bounds stalled ${phase} without replaying a mutation`, { timeout: 1500 }, async () => {
    let calls = 0; let signal;
    const stalled = new Promise(() => {});
    const call = createApiClient({ root: "https://api.example.invalid", timeoutMs: 20, fetchImpl: async (_url, input) => {
      calls++; signal = input.signal;
      return phase === "headers" ? stalled : { ok: true, text: () => stalled };
    } });
    await assert.rejects(call("/deploy", { method: "POST", body: { name: "site" } }), error => error.code === "REQUEST_TIMEOUT");
    assert.equal(calls, 1); assert.equal(signal.aborted, true);
  });
}

test("already-cancelled hosting work makes no external request", async () => {
  const controller = new AbortController(); controller.abort(); let calls = 0;
  const call = createApiClient({ root: "https://api.example.invalid", fetchImpl: async () => { calls++; return Response.json({}); } });
  await assert.rejects(call("/deploy", { method: "POST", signal: controller.signal }), error => error.code === "REQUEST_CANCELLED");
  assert.equal(calls, 0);
});

test("caller cancellation settles a stalled body and releases the caller listener", { timeout: 1500 }, async () => {
  const controller = new AbortController(); let transport;
  const call = createApiClient({ root: "https://api.example.invalid", fetchImpl: async (_url, input) => { transport = input.signal; return { ok: true, text: () => new Promise(() => {}) }; } });
  const pending = call("/status", { signal: controller.signal }); controller.abort();
  await assert.rejects(pending, error => error.code === "REQUEST_CANCELLED");
  assert.equal(transport.aborted, true);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("successful and rejected hosting calls release listeners and preserve provider responses", async () => {
  const controller = new AbortController(); let success = true;
  const call = createApiClient({ root: "https://api.example.invalid", fetchImpl: async () => Response.json(success ? { result: "ready" } : { message: "denied" }, { status: success ? 200 : 403 }) });
  for (let i = 0; i < 20; i++) assert.deepEqual(await call("/status", { signal: controller.signal }), { result: "ready" });
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  success = false;
  await assert.rejects(call("/status", { signal: controller.signal }), error => error.code === "NOT_AUTHORIZED");
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});
