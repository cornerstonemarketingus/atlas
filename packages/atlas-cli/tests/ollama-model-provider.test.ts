import assert from "node:assert/strict";
import test from "node:test";
import { OllamaModelProvider, resolveOllamaChatUrl } from "../src/infrastructure/ollama-model-provider.js";
import { isKeylessCoderProvider, selectCoderProvider } from "../src/model/coder-provider-selection.js";
import { ModelProviderError, type ModelRequest } from "../src/model/model-provider.js";

const MODEL = { model: "qwen2.5-coder:1.5b", contextWindowTokens: 4096, maxOutputTokens: 512, supportsTools: true, supportsJson: true, supportsStreaming: false };
const user = (text: string) => ({ role: "user", content: [{ type: "text", text }] }) as const;

function provider(reply: (body: any, url: string) => { status?: number; body: unknown }, models = [MODEL]) {
  const calls: Array<{ url: string; body: any }> = [];
  const fetchImplementation = (async (url: URL, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    calls.push({ url: String(url), body });
    const { status = 200, body: out } = reply(body, String(url));
    return new Response(JSON.stringify(out), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { calls, provider: new OllamaModelProvider({ models, fetchImplementation }) };
}
const ok = { model: MODEL.model, message: { role: "assistant", content: "hi" }, done_reason: "stop", prompt_eval_count: 100, eval_count: 5 };

test("labels itself ollama, takes no key, and sends the declared window per request", async () => {
  const { provider: p, calls } = provider(() => ({ body: ok }));
  const response = await p.complete({ model: MODEL.model, messages: [user("hello")], maxOutputTokens: 9999 } as ModelRequest);
  assert.equal(response.providerId, "ollama");
  assert.equal(p.metadata.id, "ollama");
  assert.equal(calls[0]!.url, "http://127.0.0.1:11434/api/chat");
  assert.equal(calls[0]!.body.options.num_ctx, 4096);
  assert.equal(calls[0]!.body.options.num_predict, 512, "output is capped at the model's declared maximum");
  assert.deepEqual(response.usage, { inputTokens: 100, outputTokens: 5, totalTokens: 105 });
  assert.equal(isKeylessCoderProvider("ollama"), true);
  assert.equal(isKeylessCoderProvider("groq"), false);
});

test("a model that was not declared is refused before any request", async () => {
  const { provider: p, calls } = provider(() => ({ body: ok }));
  await assert.rejects(p.complete({ model: "qwen2.5-coder:7b", messages: [user("x")] } as ModelRequest), (e: unknown) => e instanceof ModelProviderError && e.code === "model-unavailable");
  assert.equal(calls.length, 0);
});

test("a prompt larger than the window is refused, not silently cut by the server", async () => {
  const { provider: p, calls } = provider(() => ({ body: ok }));
  await assert.rejects(p.complete({ model: MODEL.model, messages: [user("x".repeat(60_000))] } as ModelRequest), (e: unknown) => e instanceof ModelProviderError && e.code === "invalid-request");
  assert.equal(calls.length, 0, "an oversized prompt must never be sent");
});

test("a reply whose prompt count reached the window is refused", async () => {
  const { provider: p } = provider(() => ({ body: { ...ok, prompt_eval_count: 4096 } }));
  await assert.rejects(p.complete({ model: MODEL.model, messages: [user("x")] } as ModelRequest), (e: unknown) => e instanceof ModelProviderError && /context window/u.test(e.message) && !e.retryable);
});

test("native tool calls become tool-call content with unique ids across turns", async () => {
  const call = { ...ok, message: { role: "assistant", content: "", tool_calls: [{ function: { name: "repository.inspect", arguments: { path: "." } } }] } };
  const { provider: p } = provider(() => ({ body: call }));
  const request = { model: MODEL.model, messages: [user("go")], tools: [{ name: "repository.inspect", description: "d", inputSchema: { type: "object" } }] } as ModelRequest;
  const first = await p.complete(request);
  const second = await p.complete(request);
  assert.equal(first.finishReason, "tool-calls");
  const [a, b] = [first, second].map((r) => (r.message.content[0] as { id: string }).id);
  assert.notEqual(a, b);
});

test("HTTP errors are classified without echoing the body", async () => {
  const { provider: missing } = provider(() => ({ status: 404, body: { error: "model 'secret-prompt-text' not found" } }));
  await assert.rejects(missing.complete({ model: MODEL.model, messages: [user("x")] } as ModelRequest), (e: unknown) => e instanceof ModelProviderError && e.code === "model-unavailable" && !/secret-prompt-text/u.test(e.message));
  const { provider: down } = provider(() => ({ status: 503, body: {} }));
  await assert.rejects(down.complete({ model: MODEL.model, messages: [user("x")] } as ModelRequest), (e: unknown) => e instanceof ModelProviderError && e.retryable);
});

test("endpoints: native, /v1 base and full URL resolve to /api/chat; remote http and credentials are refused", () => {
  for (const raw of ["http://127.0.0.1:11434", "http://localhost:11434/v1", "http://127.0.0.1:11434/v1/chat/completions", "http://127.0.0.1:11434/api/chat"]) {
    assert.equal(resolveOllamaChatUrl(raw).pathname, "/api/chat", raw);
  }
  assert.throws(() => resolveOllamaChatUrl("http://203.0.113.5:11434"));
  assert.throws(() => resolveOllamaChatUrl("https://user:pw@example.com"));
  assert.equal(resolveOllamaChatUrl("https://gpu.example.com").href, "https://gpu.example.com/api/chat");
});

test("provider selection: an Ollama tag stays on this machine; it is never inferred as a hosted vendor", () => {
  const chosen = selectCoderProvider({ provider: "ollama", model: "qwen2.5-coder:1.5b", tokenBudget: 16384 });
  assert.ok(chosen.ok);
  assert.equal(chosen.selection.profile.providerId, "ollama");
  // Before the local-only guarantee this inferred Groq, sending the repository
  // to a hosted API whenever GROQ_API_KEY happened to be set.
  const inferred = selectCoderProvider({ model: "qwen2.5-coder:1.5b", tokenBudget: 16384 });
  assert.ok(inferred.ok);
  assert.equal(inferred.selection.profile.providerId, "ollama");
  assert.equal(inferred.selection.inferred, true);
  // With the operator's own --base-url the OpenAI-compatible client is pointed at that server, as before.
  const custom = selectCoderProvider({ model: "qwen2.5-coder:1.5b", tokenBudget: 16384, customEndpoint: true });
  assert.ok(custom.ok);
  assert.equal(custom.selection.profile.providerId, "groq");
});

test("Qwen3 models are asked not to think, so their bounded reply is not spent on reasoning; other models are unchanged", async () => {
  for (const [name, expected] of [["qwen3:0.6b", false], ["qwen3:1.7b", false], ["qwen2.5-coder:1.5b", undefined]] as const) {
    const { provider: p, calls } = provider(() => ({ body: { ...ok, model: name } }), [{ ...MODEL, model: name }]);
    await p.complete({ model: name, messages: [user("hi")] } as ModelRequest);
    assert.equal(calls[0]!.body.think, expected, name);
  }
});
