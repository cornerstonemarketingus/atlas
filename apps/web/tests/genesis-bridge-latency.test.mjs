import assert from "node:assert/strict";
import test from "node:test";
import { genesisBridge, CAPABILITIES_TIMEOUT_MS } from "../app/api/genesis/bridge.mjs";
const environment = { ATLAS_GENESIS_URL: "https://genesis.test", ATLAS_GENESIS_TOKEN: "private-token" };
test("capability preflight settles even if the fetch ignores cancellation", async () => {
  let signal;
  const bridge = genesisBridge(environment, { owner: true, capabilityTimeoutMs: 10,
    fetchImpl: async (_url, init) => { signal = init.signal; return new Promise(() => {}); } });
  const outcome = await bridge.capabilities();
  assert.equal(outcome.github.reason, "host_unavailable");
  assert.equal(signal.aborted, true);
  assert.equal(CAPABILITIES_TIMEOUT_MS, 1500);
  assert.doesNotMatch(JSON.stringify(outcome), /private-token/);
});
test("capability deadline also bounds a stalled response body", async () => {
  const bridge = genesisBridge(environment, { owner: true, capabilityTimeoutMs: 10,
    fetchImpl: async () => ({ ok: true, json: () => new Promise(() => {}) }) });
  assert.equal((await bridge.capabilities()).github.reason, "host_unavailable");
});
test("the short read-only preflight deadline does not shorten project creation", async () => {
  const bridge = genesisBridge(environment, { owner: true, capabilityTimeoutMs: 5,
    fetchImpl: async (_url, init) => {
      await new Promise(resolve => setTimeout(resolve, 25));
      assert.equal(init.signal.aborted, false);
      return Response.json({ status: "building", operationId: "operation_12345678" });
    } });
  assert.equal((await bridge.create({ requestId: "operation_12345678" })).status, "building");
});
