import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";

// The built Worker imports this runtime-only module. Simulate an absent D1
// binding so this test exercises the documented persistence fallback in Node.
register(`data:text/javascript,${encodeURIComponent(`
  export async function resolve(specifier, context, next) {
    if (specifier === "cloudflare:workers") return { url: "data:text/javascript,export const env = {};", shortCircuit: true };
    return next(specifier, context);
  }
`)}`, import.meta.url);

test("built chat API authenticates, routes allowed choices, and answers without D1", async (t) => {
  const previous = { token: process.env.ATLAS_OPERATOR_TOKEN, profiles: process.env.ATLAS_CHAT_PROFILES };
  process.env.ATLAS_OPERATOR_TOKEN = "test-chat-operator";
  process.env.ATLAS_CHAT_PROFILES = JSON.stringify([
    { id: "fast", model: "small", baseUrl: "https://model.example/v1", apiKeyEnv: "ATLAS_OPERATOR_TOKEN" },
    { id: "coding", model: "coder", baseUrl: "http://127.0.0.1:11434/v1", reasoningEffort: "none" },
  ]);
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    return Response.json({ choices: [{ message: { content: "Verified reply" } }] });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
    for (const [key, value] of [["ATLAS_OPERATOR_TOKEN", previous.token], ["ATLAS_CHAT_PROFILES", previous.profiles]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  const { default: worker } = await import(new URL("../dist/server/index.js", import.meta.url));
  const context = { waitUntil() {}, passThroughOnException() {} };
  const headers = { authorization: "Bearer test-chat-operator", "content-type": "application/json" };
  const invoke = (method, body, auth = true) => worker.fetch(new Request("http://localhost/api/chat", {
    method, headers: auth ? headers : {}, ...(body ? { body: JSON.stringify(body) } : {}),
  }), {}, context);
  assert.equal((await invoke("GET", undefined, false)).status, 401);
  const catalog = await (await invoke("GET")).json();
  assert.equal(catalog.models.length, 2);
  assert.equal(JSON.stringify(catalog).includes("test-chat-operator"), false);
  assert.equal((await invoke("POST", { message: "Hello", modelId: "unlisted" })).status, 400);
  assert.equal(calls.length, 0);
  const response = await invoke("POST", { message: "Hello", modelId: "coding" });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.reply.content, "Verified reply");
  assert.equal(result.stored, false);
  assert.equal(result.modelId, "coding");
  assert.equal(calls[0].url, "http://127.0.0.1:11434/v1/chat/completions");
  assert.equal(calls[0].options.headers.authorization, undefined);
  assert.equal(JSON.parse(calls[0].options.body).model, "coder");
  assert.equal(JSON.parse(calls[0].options.body).reasoning_effort, "none");
});
