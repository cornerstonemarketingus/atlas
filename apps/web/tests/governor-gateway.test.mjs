import assert from "node:assert/strict";
import test from "node:test";
import { createGovernorCore } from "../worker/inference-governor-core.mjs";
import { handleGovernorGateway } from "../app/api/inference/governor-gateway.mjs";

const TOKEN = "gov-" + "0123456789abcdef0123456789abcdef";
const SCOPE = "https://api.groq.com#0123456789abcdef";

function memoryStorage() {
  const map = new Map();
  return { get: async (key) => map.get(key), put: async (key, value) => { map.set(key, structuredClone(value)); }, setAlarm: async () => {} };
}
function gateway() {
  const cores = new Map();
  const seen = [];
  const call = async (scope, method, argument) => {
    seen.push(scope);
    if (!cores.has(scope)) cores.set(scope, createGovernorCore({ storage: memoryStorage() }));
    return cores.get(scope)[method](argument);
  };
  const post = (body, headers = {}, environment = { ATLAS_GOVERNOR_TOKEN: TOKEN }) => handleGovernorGateway(
    new Request("https://atlas.test/api/inference/governor", { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) }),
    { environment, call },
  );
  return { post, seen, cores };
}

test("the gateway is off without a token and refuses wrong or missing credentials", async () => {
  const { post, seen } = gateway();
  assert.equal((await post({ method: "snapshot", scope: SCOPE }, {}, {})).status, 404);
  assert.equal((await post({ method: "snapshot", scope: SCOPE }, { authorization: "Bearer wrong" })).status, 401);
  assert.equal((await post({ method: "snapshot", scope: SCOPE }, { authorization: "" })).status, 401);
  const operatorShaped = await handleGovernorGateway(new Request("https://atlas.test/g", { method: "POST", headers: { authorization: "Bearer operator-token" }, body: "{}" }), { environment: { ATLAS_GOVERNOR_TOKEN: TOKEN, ATLAS_OPERATOR_TOKEN: "operator-token" }, call: async () => ({}) });
  assert.equal(operatorShaped.status, 401, "the operator token is not accepted here");
  assert.deepEqual(seen, [], "no governor was touched");
});

test("only the capacity methods and well-formed provider scopes are accepted", async () => {
  const { post, seen } = gateway();
  assert.equal((await post({ method: "alarm", scope: SCOPE })).status, 400);
  assert.equal((await post({ method: "reserve", scope: "javascript:alert(1)" })).status, 400);
  assert.equal((await post({ method: "reserve", scope: "https://x.test#ZZ" })).status, 400);
  assert.equal((await post({ method: "reserve", scope: SCOPE, argument: [1] })).status, 400);
  assert.equal((await post("not json")).status, 400);
  assert.equal((await post("[]")).status, 400);
  assert.equal((await post({ method: "snapshot", scope: SCOPE, argument: { pad: "x".repeat(20_000) } })).status, 413);
  assert.deepEqual(seen, []);
  assert.equal((await handleGovernorGateway(new Request("https://atlas.test/g"), { environment: { ATLAS_GOVERNOR_TOKEN: TOKEN }, call: async () => ({}) })).status, 405);
});

test("reservations go through the real governor core, per scope, and release frees them", async () => {
  const { post, cores } = gateway();
  const reserve = (requestId, scope = SCOPE) => post({ method: "reserve", scope, argument: { requestId, models: ["m1"], estimatedTokens: 100, latencyClass: "TASK_CRITICAL", priority: 0 } }).then((r) => r.json());
  const first = await reserve("req-1");
  assert.equal(first.granted, true);
  assert.equal(cores.size, 1);
  await reserve("req-1-other-scope", "https://api.openai.com");
  assert.equal(cores.size, 2, "a different provider scope has its own ledger");
  const snapshot = await (await post({ method: "snapshot", scope: SCOPE })).json();
  assert.equal(snapshot.reservations, 1);
  const released = await post({ method: "release", scope: SCOPE, argument: { requestId: "req-1", model: "m1", status: 200, kind: null } });
  assert.equal(released.status, 200);
  assert.equal((await (await post({ method: "snapshot", scope: SCOPE })).json()).reservations, 0);
});

test("an unavailable governor is a 503 the caller can treat as 'ungoverned', never a success body", async () => {
  const response = await handleGovernorGateway(
    new Request("https://atlas.test/g", { method: "POST", headers: { authorization: `Bearer ${TOKEN}` }, body: JSON.stringify({ method: "snapshot", scope: SCOPE }) }),
    { environment: { ATLAS_GOVERNOR_TOKEN: TOKEN }, call: async () => null },
  );
  assert.equal(response.status, 503);
});
