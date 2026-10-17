import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createModelClient } from "../src/agent/model-client.mjs";
import { AgentRuntime } from "../src/agent/runtime.mjs";
import { AgentSessionStore } from "../src/agent/session-store.mjs";
import { createConversationExecutor } from "../src/agent/conversation-executor.mjs";
import { ToolRegistry } from "../src/agent/tool-registry.mjs";

const request = { model: "fixture", messages: [{ role: "user", content: "inspect" }] };
const frame = (delta, finish_reason = null) => ({ choices: [{ delta, finish_reason }] });
const event = (value, eol = "\n") => `data: ${JSON.stringify(value)}${eol}${eol}`;
async function collect(client, chunks = []) {
  for await (const chunk of client.stream(request)) chunks.push(chunk);
  return chunks;
}
function clientFor(body) {
  return createModelClient({ fetchImpl: async () => new Response(body, { headers: { "content-type": "text/event-stream" } }) });
}

test("real HTTP model streams accept CRLF and preserve Unicode, tools and usage", async (t) => {
  const server = createServer(async (req, res) => {
    for await (const _ of req) { /* drain */ }
    res.writeHead(200, { "content-type": "text/event-stream" });
    const wire = ": heartbeat\r\n\r\n" + event(frame({ content: "Built 🛠 café" }), "\r\n")
      + event(frame({ tool_calls: [{ index: 0, id: "c1", function: { name: "repository.read", arguments: '{"path":' } }] }), "\r\n")
      + event(frame({ tool_calls: [{ index: 0, function: { arguments: '"README.md"}' } }] }, "tool_calls"), "\r\n")
      + event({ choices: [], usage: { completion_tokens: 9 } }, "\r\n") + "data: [DONE]\r\n\r\n";
    const bytes = Buffer.from(wire);
    for (let offset = 0; offset < bytes.length; offset += 3) res.write(bytes.subarray(offset, offset + 3));
    res.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
  const chunks = await collect(createModelClient({ baseUrl: `http://127.0.0.1:${server.address().port}/v1` }));
  assert.deepEqual(chunks.filter((x) => x.type === "text").map((x) => x.delta), ["Built 🛠 café"]);
  assert.deepEqual(chunks.find((x) => x.type === "tool_call"), { type: "tool_call", id: "c1", name: "repository.read", arguments: '{"path":"README.md"}' });
  assert.equal(chunks.at(-1).usage.completion_tokens, 9);
});

test("every byte boundary, including CRLF and UTF-8 splits, retains the answer", async () => {
  const bytes = new TextEncoder().encode(event(frame({ content: "é🛠" }), "\r\n") + event(frame({}, "stop"), "\r\n"));
  for (let split = 1; split < bytes.length; split++) {
    const body = new ReadableStream({ start(controller) { controller.enqueue(bytes.slice(0, split)); controller.enqueue(bytes.slice(split)); controller.close(); } });
    const chunks = await collect(clientFor(body));
    assert.equal(chunks.find((x) => x.type === "text")?.delta, "é🛠", `split ${split}`);
    assert.equal(chunks.at(-1).type, "done");
  }
});

test("an interrupted tool stream never releases a tool call or successful completion", async () => {
  const chunks = [];
  const body = event(frame({ tool_calls: [{ index: 0, id: "c1", function: { name: "repository.write", arguments: '{"path":' } }] }));
  await assert.rejects(collect(clientFor(body), chunks), { code: "MODEL_STREAM_INTERRUPTED" });
  assert.deepEqual(chunks, []);
});

test("partial text remains visible but EOF without completion is a failure", async () => {
  const chunks = [];
  await assert.rejects(collect(clientFor(event(frame({ content: "Partial" }))), chunks), { code: "MODEL_STREAM_INTERRUPTED" });
  assert.deepEqual(chunks, [{ type: "text", delta: "Partial" }]);
});

test("empty and reasoning-only streams are never successful answers", async () => {
  for (const body of ["", "data: [DONE]\n\n", event(frame({}, "stop")), event(frame({ reasoning: "private" })) + event(frame({}, "length"))]) {
    const chunks = [];
    await assert.rejects(collect(clientFor(body), chunks), (error) => ["MODEL_EMPTY_RESPONSE", "MODEL_STREAM_INTERRUPTED"].includes(error.code));
    assert.equal(chunks.some((x) => x.type === "done"), false);
  }
});

test("malformed events fail closed without echoing provider content", async () => {
  const chunks = [];
  await assert.rejects(collect(clientFor('data: {secret-provider-text}\n\n' + event(frame({ content: "okay" }, "stop"))), chunks), (error) => error.code === "MODEL_INVALID_RESPONSE" && !error.message.includes("secret-provider-text"));
  assert.deepEqual(chunks, []);
});

test("a complete finish frame works without DONE and a DONE sentinel closes the stream", async () => {
  for (const body of [event(frame({ content: "Okay" }, "stop")), event(frame({ content: "Okay" })) + "data: [DONE]\n\n" + event(frame({ content: "ignored" }))]) {
    const chunks = await collect(clientFor(body));
    assert.deepEqual(chunks.filter((x) => x.type === "text"), [{ type: "text", delta: "Okay" }]);
    assert.equal(chunks.at(-1).type, "done");
  }
});

test("unbounded incomplete SSE events are refused", async () => {
  await assert.rejects(collect(clientFor(`data: ${"x".repeat(1_048_577)}`)), { code: "MODEL_INVALID_RESPONSE" });
});

test("SSE multiline data and bare CR separators are parsed as complete events", async () => {
  const body = 'event: message\rdata: {"choices":\rdata: [{"delta":{"content":"Okay"},"finish_reason":"stop"}]}\r\r';
  assert.deepEqual((await collect(clientFor(body))).map((x) => x.type), ["text", "done"]);
});

test("DONE cancels a still-open reader and ignores trailing events", async () => {
  let cancelled = false;
  const body = new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode(event(frame({ content: "Okay" })) + "data: [DONE]\n\n")); },
    cancel() { cancelled = true; },
  });
  assert.equal((await collect(clientFor(body))).at(-1).type, "done");
  assert.equal(cancelled, true);
});

test("interrupted tool input remains failed and retryable across a runtime restart", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "atlas-stream-recovery-"));
  const filename = join(directory, "sessions.sqlite");
  const registry = new ToolRegistry({ policy: () => "allow" });
  let executions = 0;
  registry.register({
    name: "repository.read", description: "Read.", capability: "repository.read", risk: "low",
    timeoutMs: 1000, maxOutputCharacters: 100, requiresApproval: false,
    inputSchema: { type: "object", properties: {} },
    execute: async () => { executions++; return "read"; },
  });
  let sessions = new AgentSessionStore(filename);
  let runtime;
  const createRuntime = (client) => new AgentRuntime({ sessions, executors: { conversation: createConversationExecutor({ client, registry }) } });
  runtime = createRuntime(clientFor(event(frame({ tool_calls: [{ index: 0, id: "c1", function: { name: "repository.read", arguments: "{}" } }] }))));
  t.after(async () => { await runtime.stop(); sessions.close(); await rm(directory, { recursive: true, force: true }); });
  const session = runtime.createSession({ title: "Recover", model: "fixture", executor: "conversation" });
  runtime.submitTurn(session.id, { text: "Keep my task" });
  await runtime.drain();
  assert.equal(runtime.getSession(session.id).status, "failed");
  assert.equal(executions, 0);
  assert.ok(runtime.getEvents(session.id).some((x) => x.kind === "error" && x.data.code === "MODEL_STREAM_INTERRUPTED" && x.data.recoverable));
  assert.equal(runtime.getEvents(session.id).some((x) => x.kind === "assistant_message" && x.data.final), false);
  await runtime.stop();
  sessions.close();
  sessions = new AgentSessionStore(filename);
  runtime = createRuntime(clientFor(event(frame({ content: "Recovered." }, "stop"))));
  assert.equal(runtime.getSession(session.id).status, "failed");
  assert.equal(runtime.getTurns(session.id)[0].text, "Keep my task");
  runtime.retry(session.id);
  await runtime.drain();
  assert.equal(runtime.getSession(session.id).status, "completed");
  assert.equal(executions, 0);
  assert.equal(runtime.getEvents(session.id).filter((x) => x.kind === "assistant_message" && x.data.final).at(-1).data.text, "Recovered.");
});
