import assert from "node:assert/strict";
import http from "node:http";
import { afterEach, test } from "node:test";
import { ModelProviderError, type ModelCapabilities, type ModelRequest } from "../src/model/model-provider.js";
import { BoundedJsonHttpTransport } from "../src/infrastructure/bounded-json-http-transport.js";
import { LocalOpenAiCompatibleModelProvider } from "../src/infrastructure/local-openai-compatible-model-provider.js";

const servers: http.Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))); });

const model: ModelCapabilities = { model: "test-model", contextWindowTokens: 4096, maxOutputTokens: 1024, supportsTools: true, supportsJson: true, supportsStreaming: false };
const request: ModelRequest = { model: "test-model", messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }], tools: [{ name: "inspect", description: "Inspect", inputSchema: { type: "object" } }], maxOutputTokens: 50 };

async function serve(handler: http.RequestListener): Promise<URL> {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address !== null && typeof address === "object");
  return new URL(`http://127.0.0.1:${address.port}/v1/chat/completions`);
}

test("maps a request and validates a chat-completions response", async () => {
  let observed: unknown;
  const endpoint = await serve((incoming, response) => {
    const chunks: Buffer[] = [];
    incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
    incoming.on("end", () => {
      observed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ id: "response-1", model: "test-model", choices: [{ finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: [{ id: "call-1", type: "function", function: { name: "inspect", arguments: "{}" } }] } }], usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } }));
    });
  });
  const provider = new LocalOpenAiCompatibleModelProvider({ endpoint, models: [model] });
  const result = await provider.complete(request);
  assert.equal(result.finishReason, "tool-calls");
  const toolCall = result.message.content[0];
  assert.equal(toolCall?.type, "tool-call");
  assert.equal(toolCall?.type === "tool-call" ? toolCall.id : undefined, "call-1");
  assert.equal(toolCall?.type === "tool-call" ? toolCall.name : undefined, "inspect");
  assert.deepEqual(toolCall?.type === "tool-call" ? Object.entries(toolCall.arguments) : [], []);
  assert.equal((observed as { max_tokens: number }).max_tokens, 50);
  assert.equal((observed as { tools: unknown[] }).tools.length, 1);
});

test("normalizes malformed responses and HTTP failures", async () => {
  const malformed = new LocalOpenAiCompatibleModelProvider({ endpoint: await serve((_request, response) => response.end("{}")), models: [model] });
  await assert.rejects(malformed.complete(request), (error: unknown) => error instanceof ModelProviderError && error.code === "provider-failure");

  const failing = new LocalOpenAiCompatibleModelProvider({ endpoint: await serve((_request, response) => { response.statusCode = 503; response.end("unavailable"); }), models: [model] });
  await assert.rejects(failing.complete(request), (error: unknown) => error instanceof ModelProviderError && error.retryable);
});

test("supports cancellation and response size bounds", async () => {
  const slowEndpoint = await serve((_request, response) => setTimeout(() => response.end("{}"), 500));
  const provider = new LocalOpenAiCompatibleModelProvider({ endpoint: slowEndpoint, models: [model] });
  const controller = new AbortController();
  const completion = provider.complete(request, { signal: controller.signal });
  controller.abort();
  await assert.rejects(completion, (error: unknown) => error instanceof ModelProviderError && error.code === "cancelled" && !error.retryable);

  const largeEndpoint = await serve((_request, response) => response.end(JSON.stringify({ padding: "x".repeat(2048) })));
  const bounded = new LocalOpenAiCompatibleModelProvider({ endpoint: largeEndpoint, models: [model], transport: new BoundedJsonHttpTransport({ maxResponseBytes: 128 }) });
  await assert.rejects(bounded.complete(request), (error: unknown) => error instanceof ModelProviderError && error.code === "provider-failure");
});

test("enforces a transport timeout", async () => {
  const endpoint = await serve((_request, response) => setTimeout(() => response.end("{}"), 250));
  const provider = new LocalOpenAiCompatibleModelProvider({ endpoint, models: [model], transport: new BoundedJsonHttpTransport({ timeoutMs: 20 }) });
  await assert.rejects(provider.complete(request), (error: unknown) => error instanceof ModelProviderError && error.code === "provider-failure" && error.retryable);
});

test("rejects non-loopback endpoints without making a request", async () => {
  const provider = new LocalOpenAiCompatibleModelProvider({ endpoint: "https://example.com/v1/chat/completions", models: [model] });
  await assert.rejects(provider.complete(request), (error: unknown) => error instanceof ModelProviderError && error.code === "provider-failure");
});
