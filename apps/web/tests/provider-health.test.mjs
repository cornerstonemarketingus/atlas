import assert from "node:assert/strict";
import test from "node:test";
import { workersAIHealth, CREDENTIAL_CATEGORIES } from "../app/api/chat/provider-health.mjs";

const account = "0123456789abcdef0123456789abcdef";
const token = "cf-token-SECRET-value-1234567890";
const env = { CLOUDFLARE_ACCOUNT_ID: account, ATLAS_WORKERS_AI_TOKEN: token };
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const invalidToken = () => json(401, { success: false, errors: [{ code: 1000, message: "Invalid API Token" }] });
const active = (status = "active") => json(200, { success: true, result: { id: "token-id-PRIVATE", status } });
const authError = (status) => json(status, { success: false, errors: [{ code: 10000, message: "Authentication error" }] });
const answer = () => json(200, { choices: [{ message: { content: "OK" } }] });

/** Routes each Cloudflare API path to a scripted reply, recording every call. */
function cloudflare(routes) {
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push({ url: String(url), method: init?.method ?? "GET", authorization: init?.headers?.authorization, body: init?.body ? JSON.parse(init.body) : null });
    const path = new URL(url).pathname.replace(`/client/v4`, "").replace(account, "{account}");
    const reply = routes[path];
    if (!reply) throw new Error(`unexpected call ${path}`);
    return reply();
  };
  return { fetcher, calls };
}

const healthy = {
  "/user/tokens/verify": () => active(),
  "/accounts/{account}/ai/models/search": () => json(200, { success: true, result: [] }),
  "/accounts/{account}/ai/v1/chat/completions": answer,
};

test("a working credential is verified, permitted and proven by a real inference on chat's endpoint and model", async () => {
  const { fetcher, calls } = cloudflare(healthy);
  const health = await workersAIHealth(env, { fetcher });
  assert.equal(health.category, "OK");
  assert.deepEqual({ credential: health.credential, account: health.account, validation: health.validation, tokenKind: health.tokenKind, workersAI: health.workersAI, inference: health.inference, model: health.model },
    { credential: "configured", account: "configured", validation: "valid", tokenKind: "user", workersAI: "permitted", inference: "ok", model: "@cf/openai/gpt-oss-120b" });
  assert.deepEqual(health.http, { verify: 200, models: 200, inference: 200 });
  assert.equal(health.recommendedAction, undefined);
  assert.equal(calls.at(-1).url, `https://api.cloudflare.com/client/v4/accounts/${account}/ai/v1/chat/completions`, "the same endpoint chat uses");
  assert.equal(calls.at(-1).body.model, "@cf/openai/gpt-oss-120b");
  for (const call of calls) {
    assert.equal(call.authorization, `Bearer ${token}`, "one auth scheme everywhere");
    assert.ok(call.url.startsWith("https://api.cloudflare.com/client/v4/"), "the token goes only to Cloudflare's API");
  }
  assert.deepEqual((await workersAIHealth(env, { fetcher, infer: false })).inference, "skipped");
});

test("missing configuration is named before any call is made", async () => {
  const { fetcher, calls } = cloudflare({});
  assert.equal((await workersAIHealth({ CLOUDFLARE_ACCOUNT_ID: account }, { fetcher })).category, "CREDENTIAL_MISSING");
  assert.equal((await workersAIHealth({ ATLAS_WORKERS_AI_TOKEN: token }, { fetcher })).category, "ACCOUNT_MISSING");
  const malformed = await workersAIHealth({ ...env, CLOUDFLARE_ACCOUNT_ID: "not-an-account" }, { fetcher });
  assert.equal(malformed.account, "invalid");
  assert.equal(malformed.category, "ACCOUNT_MISSING");
  assert.equal(calls.length, 0);
});

test("a token Cloudflare does not know, as a user or account token, is invalid; an account-owned token is recognized", async () => {
  const unknown = await workersAIHealth(env, { fetcher: cloudflare({ "/user/tokens/verify": invalidToken, "/accounts/{account}/tokens/verify": invalidToken }).fetcher });
  assert.equal(unknown.category, "CREDENTIAL_INVALID");
  assert.equal(unknown.validation, "invalid");
  assert.deepEqual(unknown.http, { accountVerify: 401, verify: 401 });
  assert.deepEqual(unknown.providerErrorCodes, [1000]);
  assert.match(unknown.recommendedAction, /not the Global API Key/u);

  const owned = await workersAIHealth(env, { fetcher: cloudflare({ ...healthy, "/user/tokens/verify": invalidToken, "/accounts/{account}/tokens/verify": () => active() }).fetcher });
  assert.equal(owned.category, "OK");
  assert.equal(owned.tokenKind, "account", "an account-owned token for this very account");
});

test("expired and disabled tokens are told apart from invalid ones", async () => {
  assert.equal((await workersAIHealth(env, { fetcher: cloudflare({ "/user/tokens/verify": () => active("expired") }).fetcher })).category, "CREDENTIAL_EXPIRED");
  assert.equal((await workersAIHealth(env, { fetcher: cloudflare({ "/user/tokens/verify": () => active("disabled") }).fetcher })).category, "CREDENTIAL_DISABLED");
});

test("a valid token without Workers AI on this account is wrong account or permission, not 'invalid'", async () => {
  for (const status of [401, 403]) {
    const health = await workersAIHealth(env, { fetcher: cloudflare({ ...healthy, "/accounts/{account}/ai/models/search": () => authError(status) }).fetcher });
    assert.equal(health.category, "WRONG_ACCOUNT_OR_PERMISSION");
    assert.equal(health.validation, "valid");
    assert.equal(health.workersAI, "denied");
    assert.deepEqual(health.providerErrorCodes, [10000]);
  }
});

test("inference failures are classified: auth scheme, permission, model, rate limit, outage", async () => {
  const cases = [[401, "AUTH_SCHEME_MISMATCH"], [403, "INSUFFICIENT_PERMISSION"], [404, "MODEL_UNAVAILABLE"], [400, "MODEL_UNAVAILABLE"], [429, "PROVIDER_RATE_LIMIT"], [500, "PROVIDER_UNAVAILABLE"]];
  for (const [status, category] of cases) {
    const health = await workersAIHealth(env, { fetcher: cloudflare({ ...healthy, "/accounts/{account}/ai/v1/chat/completions": () => authError(status) }).fetcher });
    assert.equal(health.category, category, String(status));
    assert.equal(health.inference, "failed");
    assert.equal(health.http.inference, status);
  }
  const malformed = await workersAIHealth(env, { fetcher: cloudflare({ ...healthy, "/accounts/{account}/ai/v1/chat/completions": () => json(200, { nothing: true }) }).fetcher });
  assert.equal(malformed.inference, "malformed");
  const down = await workersAIHealth(env, { fetcher: async () => { throw new TypeError("fetch failed"); } });
  assert.equal(down.category, "PROVIDER_UNAVAILABLE");
});

test("a diagnosis never contains the credential, its id, or provider message text", async () => {
  const scenarios = [
    healthy,
    { "/user/tokens/verify": invalidToken, "/accounts/{account}/tokens/verify": invalidToken },
    { ...healthy, "/accounts/{account}/ai/models/search": () => authError(403) },
    { ...healthy, "/accounts/{account}/ai/v1/chat/completions": () => authError(401) },
  ];
  for (const routes of scenarios) {
    const text = JSON.stringify(await workersAIHealth(env, { fetcher: cloudflare(routes).fetcher }));
    assert.doesNotMatch(text, /SECRET|cf-token|token-id-PRIVATE|Invalid API Token|Authentication error/u);
  }
  for (const category of ["OK", "CREDENTIAL_INVALID", "WRONG_ACCOUNT_OR_PERMISSION", "AUTH_SCHEME_MISMATCH"]) assert.ok(CREDENTIAL_CATEGORIES.includes(category));
});
