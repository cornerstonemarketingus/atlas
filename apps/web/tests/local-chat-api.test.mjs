import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";

register(`data:text/javascript,${encodeURIComponent(`
  export async function resolve(specifier, context, next) {
    if (specifier === "cloudflare:workers") return { url: "data:text/javascript,export const env = {}; export class DurableObject {}", shortCircuit: true };
    return next(specifier, context);
  }
`)}`, import.meta.url);

test("built chat answers in both modes without D1 and rejects unconfigured model choices", async (t) => {
  const configuration = { ATLAS_OPERATOR_TOKEN: "test-local-chat", ATLAS_CHAT_BASE_URL: "http://127.0.0.1:11434/v1", ATLAS_CHAT_MODEL: "qwen3:0.6b", ATLAS_CHAT_MODELS: "qwen3:1.7b", ATLAS_CHAT_FALLBACK_MODEL: "none" };
  const previous = Object.fromEntries(Object.keys(configuration).map((key) => [key, process.env[key]]));
  Object.assign(process.env, configuration);
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    const sent = JSON.parse(options.body);
    calls.push({ url: String(url), headers: options.headers, sent });
    return sent.stream
      ? new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: "Hello" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } })
      : Response.json({ choices: [{ message: { content: "Hello" }, finish_reason: "stop" }] });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  const { default: worker } = await import(new URL("../dist/server/index.js", import.meta.url));
  const context = { waitUntil() {}, passThroughOnException() {} };
  const headers = { authorization: "Bearer test-local-chat", "content-type": "application/json" };
  const invoke = (method, body, auth = true) => worker.fetch(new Request("http://localhost/api/chat", { method, headers: auth ? headers : {}, ...(body ? { body: JSON.stringify(body) } : {}) }), {}, context);
  assert.equal((await invoke("GET", undefined, false)).status, 401);
  const catalog = await (await invoke("GET")).json();
  assert.ok(catalog.providers.some((choice) => choice.id === "configured:qwen3:1.7b"));
  assert.equal(JSON.stringify(catalog).includes("test-local-chat"), false);
  assert.equal((await invoke("POST", { message: "Hello", provider: "configured:unknown" })).status, 400);
  assert.equal(calls.length, 0);
  const response = await invoke("POST", { message: "Hello", provider: "configured:qwen3:1.7b" });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.reply.content, "Hello");
  assert.equal(result.stored, false);
  assert.equal(calls[0].sent.model, "qwen3:1.7b");
  assert.equal(calls[0].sent.reasoning_effort, "none");
  assert.equal(calls[0].headers.authorization, undefined);
  const stream = await invoke("POST", { message: "Hello", provider: "configured:qwen3:0.6b", stream: true });
  assert.equal(stream.status, 200);
  const events = await stream.text();
  assert.match(events, /event: done/u);
  assert.match(events, /"stored":false/u);
  assert.match(events, /"content":"Hello"/u);
});
