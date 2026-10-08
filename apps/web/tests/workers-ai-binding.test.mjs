import assert from "node:assert/strict";
import test from "node:test";
import { BINDING_BASE_URL, toChatCompletion, workersAIBindingHealth, workersAIBindingModel, workersAIBindingTransport } from "../app/api/chat/workers-ai-binding.mjs";
import { chatProviderChoices, chatRoute, resolveChatProvider } from "../app/api/chat/providers.mjs";
import { callModel, converse } from "../app/api/chat/agent-loop.mjs";

// Production: the Workers AI token was valid but lacked the Workers AI
// permission on the account (403, error 10000). The Worker's own AI binding
// needs no token and is always this account.
const account = "0123456789abcdef0123456789abcdef";

/** A stand-in for env.AI: answers each run() from a script and records the inputs. */
function fakeAI(replies) {
  const runs = [];
  return { runs, run: async (model, inputs) => { runs.push({ model, inputs }); const next = replies.shift(); if (next instanceof Error) throw next; return typeof next === "function" ? next() : next; } };
}

test("both Workers AI answer shapes become an OpenAI chat completion, tool calls included", () => {
  assert.deepEqual(toChatCompletion({ response: "Hello", usage: { prompt_tokens: 3 } }, "m").choices[0], { index: 0, message: { role: "assistant", content: "Hello" }, finish_reason: "stop" });
  const tools = toChatCompletion({ response: null, tool_calls: [{ name: "read_web_page", arguments: { url: "https://example.com" } }] }, "m").choices[0];
  assert.equal(tools.finish_reason, "tool_calls");
  assert.deepEqual(tools.message.tool_calls, [{ id: "call_0", type: "function", function: { name: "read_web_page", arguments: "{\"url\":\"https://example.com\"}" } }]);
  const openaiShape = toChatCompletion({ choices: [{ message: { content: "Hi" } }] }, "m");
  assert.equal(openaiShape.choices[0].message.content, "Hi");
  const already = toChatCompletion({ tool_calls: [{ id: "x1", type: "function", function: { name: "f", arguments: "{}" } }] }, "m");
  assert.equal(already.choices[0].message.tool_calls[0].id, "x1");
  assert.equal(toChatCompletion({ response: { a: 1 } }, "m").choices[0].message.content, "{\"a\":1}");
});

test("a whole chat turn runs on the binding, with a tool round trip, streaming and not, and no key anywhere", async () => {
  for (const stream of [false, true]) {
    const ai = fakeAI([{ tool_calls: [{ name: "read_web_page", arguments: { url: "https://example.com" } }] }, { response: "The page says: Example body." }]);
    const pages = [];
    const fetcher = async (url) => { pages.push(String(url)); return new Response("<title>Example</title><p>Example body</p>", { headers: { "content-type": "text/html" } }); };
    const endpoint = resolveChatProvider({}, "auto", { ai });
    assert.equal(endpoint.provider, "workers-ai");
    assert.equal(endpoint.apiKey, null);
    const outcome = await converse({
      endpoint, turns: [{ role: "system", content: "sys" }, { role: "user", content: "what does the page say?" }],
      toolContext: { environment: {}, allowlist: new Set(), githubToken: async () => undefined, fetcher },
      defaultRepository: "cornerstonemarketingus/atlas", userMessage: "what does the page say?", startTasks: async () => [], stream, emit: () => {}, fetcher, sleep: async () => {},
    });
    assert.equal(outcome.reply, "The page says: Example body.", `stream=${stream}`);
    assert.deepEqual(outcome.servedBy, { provider: "workers-ai", model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast" });
    assert.equal(ai.runs.length, 2);
    assert.ok(Array.isArray(ai.runs[0].inputs.tools) && ai.runs[0].inputs.tools.length > 0, "the tools reach the model");
    assert.ok(ai.runs[1].inputs.messages.some((message) => message.role === "tool"), "the tool result goes back");
    assert.ok(pages.every((url) => !url.includes("workers-ai.binding")), "nothing is fetched from the binding's address");
  }
});

test("a binding refusal is answered as a status, routes to the next provider, and never carries the binding's text", async () => {
  const ai = fakeAI([new Error("AiError: 3040: Capacity temporarily exceeded, please try again. (request text: SECRET-PROMPT)")]);
  const transport = workersAIBindingTransport(ai);
  const refused = await transport(BINDING_BASE_URL, { body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }] }) });
  assert.equal(refused.status, 429);
  assert.doesNotMatch(await refused.text(), /SECRET-PROMPT|Capacity/u);
  for (const [message, status] of [["Forbidden: not entitled", 403], ["No such model @cf/x", 404], ["Invalid input: schema", 400], ["boom", 502]]) {
    assert.equal((await workersAIBindingTransport(fakeAI([new Error(message)]))(BINDING_BASE_URL, { body: JSON.stringify({ model: "m", messages: [] }) })).status, status, message);
  }

  const env = { GROQ_API_KEY: "groq-secret" };
  const calls = [];
  // Out of capacity for the whole minute: every attempt is refused (chat retries once before routing on).
  const busy = { runs: 0, run: async () => { busy.runs += 1; throw new Error("429 Too Many Requests"); } };
  const route = resolveChatProvider(env, "auto", { ai: busy });
  const response = await callModel(route, [{ role: "user", content: "hi" }], { stream: false, tools: null, sleep: async () => {}, fetcher: async (url, init) => {
    calls.push({ url: String(url), authorization: init.headers.authorization });
    return Response.json({ choices: [{ message: { content: "from groq" } }] });
  } });
  assert.equal((await response.json()).choices[0].message.content, "from groq", "the binding's rate limit routes to Groq");
  assert.ok(calls.every((call) => call.url.startsWith("https://api.groq.com/")));
  assert.equal(busy.runs, 2, "one retry on the binding, then Groq");
});

test("the binding is preferred over the Workers AI token, keeps the route kind, and is selectable", () => {
  const ai = fakeAI([]);
  const env = { CLOUDFLARE_ACCOUNT_ID: account, ATLAS_WORKERS_AI_TOKEN: "cf-token", ATLAS_CHAT_BASE_URL: "https://api.groq.com/openai/v1", ATLAS_CHAT_MODEL: "big", GROQ_API_KEY: "g" };
  const route = resolveChatProvider(env, "auto", { ai });
  assert.equal(route.providerFallback.baseUrl, BINDING_BASE_URL, "the binding, not the token endpoint");
  assert.equal(route.providerFallback.apiKey, null);
  assert.deepEqual(chatRoute(env, { ai }), ["groq", "workers-ai"]);
  assert.equal(resolveChatProvider(env).providerFallback.baseUrl, `https://api.cloudflare.com/client/v4/accounts/${account}/ai/v1/`, "without a binding, the token endpoint as before");
  assert.equal(resolveChatProvider({}, "workers-ai", { ai }).baseUrl, BINDING_BASE_URL);
  assert.equal(chatProviderChoices({}, { ai }).find((choice) => choice.id === "workers-ai").available, true);
  assert.equal(workersAIBindingModel({ ai: {} }), null, "something that is not a binding is ignored");
  assert.equal(workersAIBindingModel({ ai }, { ATLAS_WORKERS_AI_MODEL: "@cf/qwen/x" }).model, "@cf/qwen/x");
});

test("the binding's health is a real inference, reported as categories", async () => {
  assert.deepEqual(await workersAIBindingHealth({}), { provider: "workers-ai-binding", binding: "missing", category: "BINDING_MISSING" });
  const ok = await workersAIBindingHealth({ ai: fakeAI([{ response: "OK" }]) });
  assert.equal(ok.category, "OK");
  assert.equal(ok.inference, "ok");
  const limited = await workersAIBindingHealth({ ai: fakeAI([new Error("429 Too Many Requests")]) });
  assert.equal(limited.category, "PROVIDER_RATE_LIMIT");
  assert.equal(limited.http.inference, 429);
});

test("an already aborted request never invokes AI and a deadline bounds an uncooperative binding", async () => {
  let runs = 0;
  const transport = workersAIBindingTransport({ run: async () => { runs += 1; return new Promise(() => {}); } }, { timeoutMs: 15 });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(transport(BINDING_BASE_URL, { signal: controller.signal, body: "{}" }), { name: "AbortError" });
  assert.equal(runs, 0);
  // AbortSignal.timeout timers are unref'ed in Node. Hold the test alive while
  // the unresolved fake proves the adapter itself stops waiting.
  const keepAlive = setTimeout(() => {}, 500);
  try { await assert.rejects(transport(BINDING_BASE_URL, { body: "{}" }), { name: "TimeoutError" }); }
  finally { clearTimeout(keepAlive); }
  assert.equal(runs, 1);
});

test("caller cancellation wins before completion and late streams are cancelled", async () => {
  let resolve;
  let cancelled = false;
  const ai = { run: () => new Promise((done) => { resolve = done; }) };
  const controller = new AbortController();
  const request = workersAIBindingTransport(ai)(BINDING_BASE_URL, { signal: controller.signal, body: "{}" });
  await Promise.resolve();
  controller.abort();
  await assert.rejects(request, { name: "AbortError" });
  resolve(new ReadableStream({ cancel() { cancelled = true; } }));
  await new Promise((done) => setImmediate(done));
  assert.equal(cancelled, true);
});

test("native SSE delivers its first delta before generation completes, preserving tools and usage", async () => {
  let upstream;
  let inputs;
  const ai = { run: async (_model, body) => { inputs = body; return new ReadableStream({ start(controller) { upstream = controller; } }); } };
  const response = await workersAIBindingTransport(ai)(BINDING_BASE_URL, { body: JSON.stringify({ model: "m", stream: true, messages: [] }) });
  assert.equal(inputs.stream, true);
  const reader = response.body.getReader();
  const encoder = new TextEncoder();
  upstream.enqueue(encoder.encode('data: {"response":"First"}\n\n'));
  const first = await reader.read();
  assert.match(new TextDecoder().decode(first.value), /"content":"First"/u);
  assert.equal(first.done, false);
  upstream.enqueue(encoder.encode('data: {"tool_calls":[{"name":"read_web_page","arguments":{"url":"https://example.com"}}]}\n\ndata: {"usage":{"prompt_tokens":4,"completion_tokens":2}}\n\ndata: [DONE]\n\n'));
  upstream.close();
  let rest = "";
  for (;;) { const next = await reader.read(); if (next.done) break; rest += new TextDecoder().decode(next.value); }
  assert.match(rest, /"name":"read_web_page"/u);
  assert.match(rest, /"prompt_tokens":4/u);
  assert.match(rest, /"finish_reason":"tool_calls"/u);
  assert.equal((rest.match(/\[DONE\]/gu) ?? []).length, 1);
});

test("native streaming cancellation closes the upstream and does not leak provider errors", async () => {
  let cancelled = false;
  const controller = new AbortController();
  const ai = { run: async () => new ReadableStream({ cancel() { cancelled = true; } }) };
  const response = await workersAIBindingTransport(ai)(BINDING_BASE_URL, { signal: controller.signal, body: JSON.stringify({ stream: true }) });
  const reading = response.body.getReader().read();
  controller.abort();
  await assert.rejects(reading, { name: "AbortError" });
  assert.equal(cancelled, true);
  const bad = workersAIBindingTransport({ run: async () => new ReadableStream({ start(stream) { stream.enqueue(new TextEncoder().encode('data: {"error":"SECRET-PROMPT"}\n\n')); stream.close(); } }) });
  const failed = await bad(BINDING_BASE_URL, { body: JSON.stringify({ stream: true }) });
  await assert.rejects(failed.text(), (error) => !error.message.includes("SECRET-PROMPT"));
});

test("native tool schemas are translated and unsupported forced choices are refused", async () => {
  const ai = fakeAI([{ response: "done" }, { response: "done" }]);
  const transport = workersAIBindingTransport(ai);
  const tools = [{ type: "function", function: { name: "read_web_page", parameters: { type: "object" } } }];
  await transport(BINDING_BASE_URL, { body: JSON.stringify({ model: "m", messages: [], tools, tool_choice: "none" }) });
  assert.equal(ai.runs[0].inputs.tools, undefined);
  assert.equal(ai.runs[0].inputs.tool_choice, undefined);
  const choice = { type: "function", function: { name: "read_web_page" } };
  assert.equal((await transport(BINDING_BASE_URL, { body: JSON.stringify({ model: "m", messages: [], tools, tool_choice: choice }) })).status, 400);
  assert.equal((await transport(BINDING_BASE_URL, { body: JSON.stringify({ model: "m", messages: [], tools, tool_choice: "required" }) })).status, 400);
  assert.equal(ai.runs.length, 1, "unsupported choices never invoke the model");
  await transport(BINDING_BASE_URL, { body: JSON.stringify({ model: "m", messages: [], tools, tool_choice: "auto" }) });
  assert.deepEqual(ai.runs[1].inputs.tools, [{ name: "read_web_page", parameters: { type: "object" } }]);
  const flat = fakeAI([{ response: "done" }]);
  await workersAIBindingTransport(flat)(BINDING_BASE_URL, { body: JSON.stringify({ model: "m", messages: [], tools: [{ name: "f", description: "Read", parameters: { type: "object" } }] }) });
  assert.deepEqual(flat.runs[0].inputs.tools, [{ name: "f", description: "Read", parameters: { type: "object" } }]);
});

test("health rejects empty completions and malformed calls and only known model context is advertised", async () => {
  for (const result of [{ response: "" }, { response: "   " }, { choices: [] }, { tool_calls: [{ name: "f", arguments: "not-json" }] }]) {
    assert.equal((await workersAIBindingHealth({ ai: fakeAI([result]) })).inference, "failed");
  }
  assert.equal((await workersAIBindingHealth({ ai: fakeAI([{ tool_calls: [{ name: "f", arguments: {} }] }]) })).inference, "ok");
  assert.equal(workersAIBindingModel({ ai: fakeAI([]) }).capabilities.contextTokens, 24000);
  assert.equal(workersAIBindingModel({ ai: fakeAI([]) }, { ATLAS_WORKERS_AI_MODEL: "custom" }).capabilities.contextTokens, undefined);
});

test("fragmented UTF-8 and OpenAI tool argument fragments survive native streaming", async () => {
  const text = 'data: {"choices":[{"index":0,"delta":{"content":"café"}}]}\r\n\r\n'
    + 'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call-a","function":{"name":"read_web_page","arguments":"{\\"url\\":"}}]}}]}\n\n'
    + 'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"https://example.com\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n'
    + 'data: [DONE]\n\n';
  const bytes = new TextEncoder().encode(text);
  const ai = { run: async () => new ReadableStream({ start(controller) { for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); controller.close(); } }) };
  const response = await workersAIBindingTransport(ai)(BINDING_BASE_URL, { body: JSON.stringify({ stream: true }) });
  const body = await response.text();
  assert.match(body, /café/u);
  const events = body.split("\n\n").filter((frame) => frame.startsWith("data: {")).map((frame) => JSON.parse(frame.slice(6)));
  const fragments = events.flatMap((event) => event.choices ?? []).flatMap((choice) => choice.delta?.tool_calls ?? []);
  assert.equal(fragments[0].id, "call-a");
  assert.deepEqual(JSON.parse(fragments.map((call) => call.function.arguments).join("")), { url: "https://example.com" });
  assert.equal((body.match(/"finish_reason"/gu) ?? []).length, 1);
});

test("upstream read failures are sanitized and consumer cancellation propagates", async () => {
  const failed = await workersAIBindingTransport({ run: async () => new ReadableStream({ start(controller) { controller.error(new Error("SECRET-PROMPT")); } }) })(BINDING_BASE_URL, { body: JSON.stringify({ stream: true }) });
  await assert.rejects(failed.text(), (error) => error.message === "Workers AI streaming request failed.");
  let cancelled = false;
  const response = await workersAIBindingTransport({ run: async () => new ReadableStream({ cancel() { cancelled = true; } }) })(BINDING_BASE_URL, { body: JSON.stringify({ stream: true }) });
  await response.body.cancel();
  assert.equal(cancelled, true);
});
