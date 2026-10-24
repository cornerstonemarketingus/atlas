import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { checkModelEgress, describeModelEgress, isLoopbackHost, modelEgressPolicy, resolveModelProtocol, resolveOllamaBaseUrl } from "../src/agent/models/egress.mjs";
import { createDaemonModelClient, daemonContextWindow, defaultModelEndpoint } from "../src/agent/models/daemon-client.mjs";
import { buildOllamaChatRequest, createOllamaChatClient } from "../src/agent/models/ollama-chat-client.mjs";
import { createModelClient, ModelRequestError } from "../src/agent/model-client.mjs";
import { createRoutedClient } from "../src/agent/models/routed-client.mjs";
import { createSpeechTranscriber } from "../src/agent/speech.mjs";
import { createVisionReviewer } from "../src/platform/genesis/vision.mjs";
import { createGenesisCoder } from "../src/platform/genesis/coder.mjs";
import { pickInstalledCoder, resolveLocalCoder } from "../src/agent/models/local-coder.mjs";
import { discoverModelServers } from "../src/agent/models/discovery.mjs";
import { startFakeOllama } from "./helpers/fake-ollama-server.mjs";
import { installNetworkGuard } from "./helpers/network-guard.mjs";

// Provider keys that merely exist must never pull a request off this machine.
const KEYS = { GROQ_API_KEY: "gsk_" + "x".repeat(40), OPENAI_API_KEY: "sk-" + "y".repeat(40), ANTHROPIC_API_KEY: "sk-ant-" + "z".repeat(30), GEMINI_API_KEY: "g", OPENROUTER_API_KEY: "o", MISTRAL_API_KEY: "m", CEREBRAS_API_KEY: "c" };
const collect = async (iterable) => { const out = []; for await (const chunk of iterable) out.push(chunk); return out; };

test("with only provider keys in the environment the policy is local-only, and keys are never a source of endpoints", () => {
  const policy = modelEgressPolicy({ ...KEYS });
  assert.equal(policy.localOnly, true);
  assert.deepEqual(describeModelEgress(policy), { mode: "local-only", forced: false, remote: [], refused: [], remoteFallback: false });
  assert.throws(() => checkModelEgress("https://api.groq.com/openai/v1/chat/completions", policy), (error) => error instanceof ModelRequestError && error.code === "REMOTE_MODEL_REFUSED" && /local-only/u.test(error.message));
  assert.throws(() => checkModelEgress("https://api.openai.com/v1/chat/completions", policy), /REMOTE_MODEL_REFUSED|Refused/u);
  for (const local of ["http://127.0.0.1:11434/api/chat", "http://localhost:11434/v1", "http://[::1]:8080/v1", "http://127.0.0.2:1/x"]) {
    assert.equal(checkModelEgress(local, policy).remote, false, local);
  }
});

test("a remote endpoint is allowed only when the owner names it, and ATLAS_LOCAL_ONLY overrides even that", () => {
  const configured = modelEgressPolicy({ ...KEYS, ATLAS_MODEL_ENDPOINT: "https://gpu.example.net/v1", ATLAS_MODEL_ROUTES: JSON.stringify([{ task: "planning", model: "m", endpoint: "https://router.example.org/v1" }]) });
  assert.equal(configured.localOnly, false);
  assert.deepEqual(checkModelEgress("https://gpu.example.net/v1/chat/completions", configured), { remote: true, host: "gpu.example.net", variable: "ATLAS_MODEL_ENDPOINT" });
  assert.equal(checkModelEgress("https://router.example.org/v1/chat/completions", configured).variable, "ATLAS_MODEL_ROUTES");
  // A vendor the owner did not name is still refused, keys or not.
  assert.throws(() => checkModelEgress("https://api.groq.com/openai/v1/chat/completions", configured), /not one of the remote model endpoints/u);
  const forced = modelEgressPolicy({ ATLAS_LOCAL_ONLY: "1", ATLAS_MODEL_ENDPOINT: "https://gpu.example.net/v1" });
  assert.equal(forced.localOnly, true);
  assert.deepEqual(forced.refused, [{ host: "gpu.example.net", variable: "ATLAS_MODEL_ENDPOINT" }]);
  assert.throws(() => checkModelEgress("https://gpu.example.net/v1/chat/completions", forced), /ATLAS_LOCAL_ONLY is on/u);
  assert.equal(modelEgressPolicy({ ATLAS_MODEL_ENDPOINT: "https://gpu.example.net/v1", ATLAS_MODEL_REMOTE_FALLBACK: "1" }).remoteFallback, true);
  assert.equal(modelEgressPolicy({ ATLAS_LOCAL_ONLY: "true", ATLAS_MODEL_REMOTE_FALLBACK: "1" }).remoteFallback, false);
});

test("loopback detection does not accept look-alike hosts", () => {
  for (const host of ["127.0.0.1", "127.1.2.3", "localhost", "a.localhost", "::1", "[::1]"]) assert.equal(isLoopbackHost(host), true, host);
  for (const host of ["127.0.0.1.evil.example", "localhost.example", "0.0.0.0", "10.0.0.1", "192.168.1.5", "::ffff:8.8.8.8"]) assert.equal(isLoopbackHost(host), false, host);
});

test("the Ollama address honours ATLAS_OLLAMA_URL, then OLLAMA_HOST in every form Ollama accepts", () => {
  assert.equal(resolveOllamaBaseUrl({}), "http://127.0.0.1:11434");
  assert.equal(resolveOllamaBaseUrl({ OLLAMA_HOST: "127.0.0.1:11500" }), "http://127.0.0.1:11500");
  assert.equal(resolveOllamaBaseUrl({ OLLAMA_HOST: "0.0.0.0" }), "http://127.0.0.1:11434");
  assert.equal(resolveOllamaBaseUrl({ OLLAMA_HOST: "0.0.0.0:9999" }), "http://127.0.0.1:9999");
  assert.equal(resolveOllamaBaseUrl({ OLLAMA_HOST: "http://localhost:12345" }), "http://localhost:12345");
  assert.equal(resolveOllamaBaseUrl({ OLLAMA_HOST: "x:1", ATLAS_OLLAMA_URL: "http://127.0.0.1:2/" }), "http://127.0.0.1:2");
  assert.equal(defaultModelEndpoint({ OLLAMA_HOST: "127.0.0.1:11500" }), "http://127.0.0.1:11500/v1");
  assert.equal(defaultModelEndpoint({ ATLAS_MODEL_ENDPOINT: "http://127.0.0.1:8080/v1" }), "http://127.0.0.1:8080/v1");
  // A remote OLLAMA_HOST is an explicit choice, recorded as such.
  assert.equal(modelEgressPolicy({ OLLAMA_HOST: "https://ollama.example.net" }).allowed.get("https://ollama.example.net"), "OLLAMA_HOST");
});

test("the local Ollama speaks its native API; other servers stay OpenAI-compatible", () => {
  assert.equal(resolveModelProtocol("http://127.0.0.1:11434/v1", {}), "ollama");
  assert.equal(resolveModelProtocol("http://127.0.0.1:8080/v1", {}), "openai");
  assert.equal(resolveModelProtocol("http://127.0.0.1:5555/v1", { ATLAS_OLLAMA_URL: "http://127.0.0.1:5555" }), "ollama");
  assert.equal(resolveModelProtocol("http://127.0.0.1:8080/v1", { ATLAS_MODEL_PROTOCOL: "ollama" }), "ollama");
  assert.equal(resolveModelProtocol("http://127.0.0.1:11434/v1", { ATLAS_MODEL_PROTOCOL: "openai" }), "openai");
  assert.equal(createDaemonModelClient({ env: {} }).protocol, "ollama");
  assert.deepEqual(daemonContextWindow({}, "ollama"), { contextWindow: 16_384, contextSource: "configured" });
  assert.deepEqual(daemonContextWindow({ ATLAS_MODEL_CONTEXT_WINDOW: "8192" }, "openai"), { contextWindow: 8192, contextSource: "configured" });
});

test("native /api/chat against a real HTTP server: num_ctx, tools, tool results, thinking and usage", async (t) => {
  const fake = await startFakeOllama({
    models: ["qwen2.5-coder:7b", "qwen3:0.6b"],
    respond: (request) => request.messages.at(-1).role === "tool"
      ? { content: "The README says hello." }
      : { thinking: "private", content: "Reading it.", toolCalls: [{ name: "repository.read", arguments: { path: "README.md" } }] },
  });
  t.after(() => fake.close());
  const client = createOllamaChatClient({ baseUrl: `${fake.origin}/v1`, contextWindow: 12_288 });
  const tools = [{ type: "function", function: { name: "repository.read", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } } } } }];
  const first = await collect(client.stream({ model: "qwen2.5-coder:7b", messages: [{ role: "system", content: "You are Atlas." }, { role: "user", content: "What does the README say?" }], tools, maxOutputTokens: 512 }));
  assert.deepEqual(first.filter((c) => c.type === "reasoning").map((c) => c.delta), ["private"]);
  assert.equal(first.filter((c) => c.type === "text").map((c) => c.delta).join(""), "Reading it.");
  const call = first.find((c) => c.type === "tool_call");
  assert.equal(call.name, "repository.read");
  assert.deepEqual(JSON.parse(call.arguments), { path: "README.md" });
  assert.equal(first.at(-1).type, "done");
  assert.equal(first.at(-1).finishReason, "tool_calls");
  assert.equal(first.at(-1).usage.completion_tokens, 12);
  const sent = fake.chats()[0];
  assert.equal(sent.path, "/api/chat");
  assert.equal(sent.body.stream, true);
  assert.deepEqual(sent.body.options, { num_ctx: 12_288, num_predict: 512, temperature: 0 });
  assert.equal(sent.body.tools[0].function.name, "repository.read");

  // The tool result goes back in Ollama's shape: arguments as an object, the tool named.
  const second = await collect(client.stream({ model: "qwen2.5-coder:7b", tools, messages: [
    { role: "user", content: "What does the README say?" },
    { role: "assistant", content: "", tool_calls: [{ id: call.id, type: "function", function: { name: call.name, arguments: call.arguments } }] },
    { role: "tool", tool_call_id: call.id, content: "hello" },
  ] }));
  assert.equal(second.filter((c) => c.type === "text").map((c) => c.delta).join(""), "The README says hello.");
  const replay = fake.chats()[1].body.messages;
  assert.deepEqual(replay[1].tool_calls, [{ function: { name: "repository.read", arguments: { path: "README.md" } } }]);
  assert.deepEqual(replay[2], { role: "tool", content: "hello", tool_name: "repository.read" });

  // Small Qwen3 models do not spend the reply budget on hidden reasoning.
  await collect(client.stream({ model: "qwen3:0.6b", messages: [{ role: "user", content: "hi" }] }));
  assert.equal(fake.chats()[2].body.think, false);
  assert.equal(buildOllamaChatRequest({ model: "qwen2.5-coder:7b", messages: [] }).think, undefined);
});

test("images in a message become Ollama's images array", () => {
  const body = buildOllamaChatRequest({ model: "qwen2.5vl:7b", messages: [{ role: "user", content: [{ type: "text", text: "look" }, { type: "image_url", image_url: { url: "data:image/png;base64,QUJD" } }] }] });
  assert.deepEqual(body.messages[0], { role: "user", content: "look", images: ["QUJD"] });
});

test("Ollama down or model missing: a clear error that names the fix and never mentions a hosted switch as an option", async (t) => {
  const down = createOllamaChatClient({ baseUrl: "http://127.0.0.1:9" });
  await assert.rejects(collect(down.stream({ model: "qwen2.5-coder:7b", messages: [{ role: "user", content: "hi" }] })), (error) => error.code === "MODEL_UNREACHABLE" && /ollama serve/u.test(error.message) && /does not switch to a hosted provider/u.test(error.message));
  const fake = await startFakeOllama({ models: ["qwen3:0.6b"] });
  t.after(() => fake.close());
  await assert.rejects(collect(createOllamaChatClient({ baseUrl: fake.origin }).stream({ model: "qwen2.5-coder:7b", messages: [{ role: "user", content: "hi" }] })), (error) => error.code === "MODEL_NOT_FOUND" && /ollama pull qwen2\.5-coder:7b/u.test(error.message));
});

test("a stream that stops before done:true is refused, never treated as an answer", async () => {
  const body = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(`${JSON.stringify({ message: { content: "partial" }, done: false })}\n`)); controller.close(); } });
  const client = createOllamaChatClient({ baseUrl: "http://127.0.0.1:11434", fetchImpl: async () => new Response(body, { status: 200 }) });
  await assert.rejects(collect(client.stream({ model: "m", messages: [] })), (error) => error.code === "MODEL_STREAM_INTERRUPTED");
});

test("the OpenAI-compatible client against the fake server's /v1 path still works and still obeys the policy", async (t) => {
  const fake = await startFakeOllama({ respond: () => ({ content: "compat", toolCalls: [{ name: "x.y", arguments: { a: 1 } }] }) });
  t.after(() => fake.close());
  const chunks = await collect(createModelClient({ baseUrl: `${fake.origin}/v1` }).stream({ model: "qwen2.5-coder:7b", messages: [{ role: "user", content: "hi" }], tools: [{ type: "function", function: { name: "x.y" } }] }));
  assert.equal(chunks.filter((c) => c.type === "text").map((c) => c.delta).join(""), "compat");
  assert.deepEqual(chunks.find((c) => c.type === "tool_call"), { type: "tool_call", id: "call_0", name: "x.y", arguments: '{"a":1}' });
  let fetched = false;
  const refused = createModelClient({ baseUrl: "https://api.groq.com/openai/v1", fetchImpl: async () => { fetched = true; return new Response(""); }, egress: modelEgressPolicy({ ...KEYS }) });
  await assert.rejects(collect(refused.stream({ model: "openai/gpt-oss-120b", messages: [] })), (error) => error.code === "REMOTE_MODEL_REFUSED");
  assert.equal(fetched, false, "nothing was sent");
});

test("remote requests the owner configured are reported for the audit log", async () => {
  const seen = [];
  const client = createModelClient({ baseUrl: "https://gpu.example.net/v1", egress: modelEgressPolicy({ ATLAS_MODEL_ENDPOINT: "https://gpu.example.net/v1" }), onRemote: (entry) => seen.push(entry),
    fetchImpl: async () => new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`) });
  await collect(client.stream({ model: "big", messages: [] }));
  assert.deepEqual(seen, [{ host: "gpu.example.net", variable: "ATLAS_MODEL_ENDPOINT", model: "big", purpose: "chat" }]);
});

test("a local route never fails over to a remote route unless ATLAS_MODEL_REMOTE_FALLBACK is set", async () => {
  const routes = [
    { task: "planning", model: "local", endpoint: "http://127.0.0.1:11434/v1" },
    { task: "planning", model: "cloud", endpoint: "https://gpu.example.net/v1" },
  ];
  const calls = [];
  const createClient = (route) => ({ async *stream() { calls.push(route.model); if (route.model === "local") throw new ModelRequestError("MODEL_UNREACHABLE", "down"); yield { type: "text", delta: "cloud answer" }; yield { type: "done" }; } });
  const strict = createRoutedClient({ routes, createClient, fallback: null, egress: modelEgressPolicy({ ATLAS_MODEL_ROUTES: JSON.stringify(routes) }) });
  await assert.rejects(collect(strict.stream({ model: "local", messages: [] })), (error) => /not tried, it is remote/u.test(error.message) && /ATLAS_MODEL_REMOTE_FALLBACK/u.test(error.message));
  assert.deepEqual(calls, ["local"]);
  const opted = createRoutedClient({ routes, createClient, fallback: null, egress: modelEgressPolicy({ ATLAS_MODEL_ROUTES: JSON.stringify(routes), ATLAS_MODEL_REMOTE_FALLBACK: "1" }) });
  assert.equal((await collect(opted.stream({ model: "local", messages: [] })))[0].delta, "cloud answer");
  // The owner choosing the remote model for a session is explicit, not a fallback.
  calls.length = 0;
  assert.equal((await collect(strict.stream({ model: "cloud", messages: [] })))[0].delta, "cloud answer");
  assert.deepEqual(calls, ["cloud"]);
});

test("speech, Genesis vision and the Genesis coder refuse an unconfigured remote endpoint before sending anything", async () => {
  let sent = 0;
  const fetchImpl = async () => { sent += 1; return new Response("{}"); };
  const policy = modelEgressPolicy({ ...KEYS });
  const speech = createSpeechTranscriber({ baseUrl: "https://api.openai.com/v1", fetchImpl, egress: policy });
  await assert.rejects(speech.transcribe({ audio: Buffer.from("RIFF"), mediaType: "audio/wav" }), (error) => error.code === "REMOTE_MODEL_REFUSED" && /transcription/u.test(error.message));
  const vision = createVisionReviewer({ environment: { ATLAS_GENESIS_VISION_BASE_URL: "https://api.openai.com/v1", ATLAS_GENESIS_VISION_MODEL: "gpt-4o" }, fetchImpl, egress: policy });
  const screenshot = join(mkdtempSync(join(tmpdir(), "atlas-vision-")), "home-1280.png");
  writeFileSync(screenshot, Buffer.from("89504e470d0a1a0a", "hex"));
  const verdict = await vision({ id: "p" }, [screenshot]);
  assert.equal(verdict.reviewed, false);
  assert.match(verdict.reason, /Refused to send a vision request to api\.openai\.com/u);
  const coder = createGenesisCoder({ atlasRoot: "/nonexistent", dataDirectory: "/tmp", environment: { ATLAS_GENESIS_BASE_URL: "https://api.openai.com/v1" }, fetchImpl, egress: policy });
  await assert.rejects(coder({ workspace: "/tmp", objective: "x" }), (error) => error.code === "REMOTE_MODEL_REFUSED");
  assert.equal(sent, 0);
});

test("default local coder choice skips embedding models that /api/tags also lists", () => {
  assert.equal(pickInstalledCoder(["nomic-embed-text:latest", "llama3.1:8b"]), "llama3.1:8b");
  assert.equal(pickInstalledCoder(["mxbai-embed-large", "bge-m3:latest", "all-minilm:22m"]), null);
  assert.equal(pickInstalledCoder(["nomic-embed-text", "qwen2.5-coder:1.5b", "qwen3:1.7b"]), "qwen2.5-coder:1.5b");
  assert.equal(resolveLocalCoder({ env: {}, installed: ["nomic-embed-text:latest"] }).model, "qwen3:0.6b", "only an embedding model: the default, so the coder reports it missing");
});

test("discovery reads /api/tags from the fake server, and the guard sees only loopback", async (t) => {
  const fake = await startFakeOllama({ models: ["qwen2.5-coder:7b", "nomic-embed-text:latest"] });
  t.after(() => fake.close());
  const guard = installNetworkGuard({ logFile: null });
  try {
    const servers = await discoverModelServers({ endpoints: [`${fake.origin}/v1`] });
    assert.equal(servers[0].kind, "ollama");
    assert.deepEqual(servers[0].models.map((m) => m.name), ["qwen2.5-coder:7b", "nomic-embed-text:latest"]);
    assert.equal(guard.blocked().length, 0);
    assert.ok(guard.attempts.length > 0, "the guard saw the connection");
  } finally { guard.uninstall(); }
});

test("the network guard itself blocks a non-loopback destination (so a green run means something)", async () => {
  const guard = installNetworkGuard({ logFile: null });
  try {
    await assert.rejects(fetch("https://api.groq.com/openai/v1/models"), /NETWORK_GUARD/u);
    const { connect } = await import("node:net");
    assert.throws(() => connect({ host: "203.0.113.7", port: 443 }), /NETWORK_GUARD/u);
    assert.deepEqual(guard.blocked().map((entry) => entry.host), ["api.groq.com", "203.0.113.7"]);
  } finally { guard.uninstall(); }
});
