import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AgentSessionStore } from "../src/agent/session-store.mjs";
import { AgentRuntime } from "../src/agent/runtime.mjs";
import { createConversationExecutor } from "../src/agent/conversation-executor.mjs";
import { createModelClient, ModelRequestError } from "../src/agent/model-client.mjs";
import { ToolRegistry, ToolError, actionDigest, validateAgainstSchema } from "../src/agent/tool-registry.mjs";
import { registerRepositoryTools, confineToRepository } from "../src/agent/tools/repository-tools.mjs";
import { compactConversation, ContextTooLargeError, measure } from "../src/agent/compaction.mjs";
import { ReasoningAccumulator, publicErrorMessage, stripInlineReasoning } from "../src/agent/reasoning.mjs";
import { extractPdfText, loadAttachment, normalizeAttachment, toModelContent, AttachmentError } from "../src/agent/attachments.mjs";
import { createSpeechTranscriber } from "../src/agent/speech.mjs";
import { PlatformTaskStore } from "../src/platform/task-store.mjs";

/** Builds an SSE body the way an OpenAI-compatible server streams one. */
function sseResponse(frames) {
  const body = frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

const textFrame = (content) => ({ choices: [{ delta: { content } }] });
const doneFrame = (finish = "stop", usage = null) => ({ choices: [{ delta: {}, finish_reason: finish }], usage });

function scriptedClient(turns) {
  let call = 0;
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push(JSON.parse(init.body));
    const frames = turns[Math.min(call, turns.length - 1)];
    call += 1;
    return typeof frames === "function" ? frames() : sseResponse(frames);
  };
  return { client: createModelClient({ baseUrl: "http://127.0.0.1:11434/v1", fetchImpl }), seen, calls: () => call };
}

async function harness(t, { executor, registry, platformStore = null }) {
  const directory = await mkdtemp(join(tmpdir(), "atlas-conv-"));
  const sessions = new AgentSessionStore(join(directory, "agent.sqlite"));
  const durableStore = platformStore ?? null;
  const runtime = new AgentRuntime({ sessions, executors: { conversation: executor }, platformStore: durableStore });
  t.after(async () => { await runtime.stop(); sessions.close(); durableStore?.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, sessions, runtime, registry, platformStore: durableStore };
}

function openRegistry() {
  return new ToolRegistry({ policy: () => "allow", secrets: (name) => (name === "PRESENT_SECRET" ? "s3cret-value" : null) });
}

test("the model client streams text, tool calls, and usage from an SSE body", async () => {
  const { client } = scriptedClient([[
    { choices: [{ delta: { reasoning_content: "hidden thinking" } }] },
    textFrame("Hello "),
    textFrame("world"),
    { choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "repository.", arguments: '{"pa' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "read", arguments: 'th":"a.txt"}' } }] } }] },
    doneFrame("tool_calls", { completion_tokens: 12 }),
  ]]);

  const chunks = [];
  for await (const chunk of client.stream({ model: "m", messages: [{ role: "user", content: "hi" }] })) chunks.push(chunk);

  assert.deepEqual(chunks.filter((c) => c.type === "text").map((c) => c.delta), ["Hello ", "world"]);
  assert.deepEqual(chunks.filter((c) => c.type === "reasoning").map((c) => c.delta), ["hidden thinking"]);
  const call = chunks.find((c) => c.type === "tool_call");
  assert.equal(call.name, "repository.read", "name fragments across frames are joined");
  assert.deepEqual(JSON.parse(call.arguments), { path: "a.txt" }, "argument fragments across frames are joined");
  assert.equal(chunks.at(-1).usage.completion_tokens, 12);
});

test("authentication and invalid-input model failures are terminal, not retryable", async () => {
  for (const [status, code] of [[401, "MODEL_NOT_AUTHORIZED"], [403, "MODEL_NOT_AUTHORIZED"], [400, "MODEL_INVALID_INPUT"], [500, "MODEL_REQUEST_FAILED"]]) {
    const client = createModelClient({ baseUrl: "http://127.0.0.1:11434/v1", fetchImpl: async () => new Response("nope", { status }) });
    await assert.rejects(
      async () => { for await (const _ of client.stream({ model: "m", messages: [] })) { /* drain */ } },
      (error) => error instanceof ModelRequestError && error.code === code,
    );
  }
});

test("an unreachable model server produces an instruction, not 'fetch failed'", async () => {
  const client = createModelClient({
    baseUrl: "http://127.0.0.1:11434/v1",
    fetchImpl: async () => { throw new TypeError("fetch failed"); },
  });
  await assert.rejects(
    async () => { for await (const _ of client.stream({ model: "m", messages: [] })) { /* drain */ } },
    (error) => error.code === "MODEL_UNREACHABLE" && /Start Ollama/u.test(error.message) && /127\.0\.0\.1:11434/u.test(error.message),
  );

  // A cancelled request is the operator's decision and keeps its own error.
  const controller = new AbortController();
  controller.abort();
  const cancellable = createModelClient({
    baseUrl: "http://127.0.0.1:11434/v1",
    fetchImpl: async () => { throw new DOMException("aborted", "AbortError"); },
  });
  await assert.rejects(
    async () => { for await (const _ of cancellable.stream({ model: "m", messages: [], signal: controller.signal })) { /* drain */ } },
    (error) => error.name === "AbortError",
  );
});

test("a non-loopback model endpoint must use HTTPS", () => {
  assert.throws(() => createModelClient({ baseUrl: "http://example.invalid/v1" }), /HTTPS unless it is loopback/u);
  assert.doesNotThrow(() => createModelClient({ baseUrl: "https://example.invalid/v1" }));
  assert.doesNotThrow(() => createModelClient({ baseUrl: "http://127.0.0.1:11434/v1" }));
});

test("private reasoning never reaches the client", () => {
  assert.equal(stripInlineReasoning("<think>secret plan</think>The answer is 4."), "The answer is 4.");
  assert.equal(stripInlineReasoning("<thinking>a</thinking> b <reasoning>c</reasoning>"), "b");
  // A truncated stream leaves the block unterminated; it must still be removed.
  assert.equal(stripInlineReasoning("visible<think>cut off mid-thought"), "visible");

  let clock = 0;
  const accumulator = new ReasoningAccumulator({ now: () => clock });
  accumulator.record("the user's password is hunter2 so I should");
  clock = 3000;
  const summary = accumulator.summary();
  assert.match(summary, /Thought for 3s/u);
  assert.equal(summary.includes("hunter2"), false, "the default summary reveals no reasoning content");
});

test("provider implementation detail is stripped, but the operator's own address is not", () => {
  const message = publicErrorMessage(new Error("POST https://api.vendor.example/v1/chat failed with Bearer sk-abc123456789 rejected"));
  assert.equal(message.includes("api.vendor.example"), false);
  assert.equal(message.includes("sk-abc123456789"), false);
  assert.match(message, /\[endpoint\]/u);

  // A loopback address is the one detail that makes "nothing answered"
  // actionable, and it cannot leak anybody's credential.
  const local = publicErrorMessage(new Error("No model server answered at http://127.0.0.1:11434 . Start Ollama."));
  assert.match(local, /http:\/\/127\.0\.0\.1:11434/u);
  assert.match(publicErrorMessage(new Error("at http://localhost:8080 nothing")), /localhost:8080/u);

  // Unless it carries credentials or a query string, which it should not.
  assert.match(publicErrorMessage(new Error("at http://user:pw@127.0.0.1:11434 nothing")), /\[endpoint\]/u);
  assert.match(publicErrorMessage(new Error("at http://127.0.0.1:11434/v1?key=secret nothing")), /\[endpoint\]/u);
});

test("the registry refuses an incomplete tool declaration", () => {
  const registry = openRegistry();
  assert.throws(() => registry.register({ name: "bad" }), (error) => error instanceof ToolError && error.code === "INCOMPLETE_DECLARATION");
  const complete = {
    name: "demo.echo", description: "Echo.", capability: "demo", risk: "low",
    timeoutMs: 1000, maxOutputCharacters: 100, requiresApproval: false,
    inputSchema: { type: "object", required: [], properties: {} }, execute: async () => "ok",
  };
  registry.register(complete);
  assert.throws(() => registry.register(complete), (error) => error.code === "DUPLICATE_TOOL");
  assert.throws(() => registry.register({ ...complete, name: "demo.two", risk: "catastrophic" }), /risk from/u);
});

test("schema validation fails closed on unknown, missing, and malformed arguments", () => {
  const schema = {
    type: "object",
    required: ["path"],
    properties: {
      path: { type: "string", maxLength: 10 },
      depth: { type: "integer", minimum: 1, maximum: 3, default: 1 },
      mode: { type: "string", enum: ["read", "write"] },
    },
  };
  assert.deepEqual(validateAgainstSchema(schema, { path: "a.txt" }), { path: "a.txt", depth: 1 }, "defaults are applied");
  assert.throws(() => validateAgainstSchema(schema, {}), /path is required/u);
  assert.throws(() => validateAgainstSchema(schema, { path: "a", surprise: 1 }), /not an accepted argument/u);
  assert.throws(() => validateAgainstSchema(schema, { path: "a", depth: 9 }), /at most 3/u);
  assert.throws(() => validateAgainstSchema(schema, { path: "a", depth: 1.5 }), /must be an integer/u);
  assert.throws(() => validateAgainstSchema(schema, { path: "waaaaaaaaay too long" }), /at most 10 characters/u);
  assert.throws(() => validateAgainstSchema(schema, { path: "a", mode: "delete" }), /must be one of/u);
});

test("the model cannot invoke an unregistered tool", async () => {
  const registry = openRegistry();
  const result = await registry.invoke({ name: "filesystem.rm_rf", rawArguments: "{}", sessionId: "s" });
  assert.equal(result.status, "rejected");
  assert.equal(result.code, "UNKNOWN_TOOL");
});

test("policy denial, missing credentials, timeouts, and retries behave as declared", async () => {
  const denying = new ToolRegistry({ policy: (capability) => (capability === "danger" ? "deny" : "allow"), secrets: () => null });
  const base = {
    description: "x", risk: "low", timeoutMs: 50, maxOutputCharacters: 500,
    requiresApproval: false, inputSchema: { type: "object", required: [], properties: {} },
  };
  denying.register({ ...base, name: "danger.act", capability: "danger", execute: async () => "ran" });
  denying.register({ ...base, name: "slow.act", capability: "safe", execute: () => new Promise(() => {}) });
  denying.register({ ...base, name: "needs.secret", capability: "safe", credentials: ["ABSENT_SECRET"], execute: async () => "ran" });
  let attempts = 0;
  denying.register({ ...base, name: "flaky.act", capability: "safe", retries: 2, execute: async () => { attempts += 1; if (attempts < 3) throw new Error("transient"); return "recovered"; } });
  let authAttempts = 0;
  denying.register({ ...base, name: "authfail.act", capability: "safe", retries: 3, execute: async () => { authAttempts += 1; const e = new Error("no"); e.code = "NOT_AUTHORIZED"; throw e; } });

  assert.equal((await denying.invoke({ name: "danger.act", rawArguments: "{}", sessionId: "s" })).code, "POLICY_DENIED");
  assert.equal((await denying.invoke({ name: "slow.act", rawArguments: "{}", sessionId: "s" })).code, "TOOL_TIMEOUT");
  const missing = await denying.invoke({ name: "needs.secret", rawArguments: "{}", sessionId: "s" });
  assert.equal(missing.code, "MISSING_CREDENTIAL");
  assert.equal(missing.message.includes("ABSENT_SECRET"), true, "the operator is told which credential to add");
  assert.equal((await denying.invoke({ name: "flaky.act", rawArguments: "{}", sessionId: "s" })).output, "recovered");
  await denying.invoke({ name: "authfail.act", rawArguments: "{}", sessionId: "s" });
  assert.equal(authAttempts, 1, "an authorization failure is not retried");
});

test("credential values never appear in the tools offered to the model or in output", async () => {
  const registry = openRegistry();
  registry.register({
    name: "vault.use", description: "Uses a secret.", capability: "safe", risk: "low",
    timeoutMs: 1000, maxOutputCharacters: 500, requiresApproval: false, credentials: ["PRESENT_SECRET"],
    inputSchema: { type: "object", required: [], properties: {} },
    execute: async ({ credentials }) => {
      assert.equal(credentials.PRESENT_SECRET, "s3cret-value", "the tool receives the value it declared");
      return "used the credential";
    },
  });
  const offered = JSON.stringify(registry.toModelTools());
  assert.equal(offered.includes("s3cret-value"), false);
  assert.equal(offered.includes("PRESENT_SECRET"), false, "even the reference name is not advertised to the model");
  const result = await registry.invoke({ name: "vault.use", rawArguments: "{}", sessionId: "s" });
  assert.equal(result.output.includes("s3cret-value"), false);
});

test("an approval is bound to the exact action and cannot be replayed", async () => {
  const granted = new Set();
  const registry = new ToolRegistry({ policy: () => "allow" });
  registry.register({
    name: "mail.send", description: "Send a message.", capability: "communications", risk: "high",
    timeoutMs: 1000, maxOutputCharacters: 500, requiresApproval: true,
    inputSchema: { type: "object", required: ["to"], properties: { to: { type: "string", maxLength: 100 } } },
    execute: async ({ input }) => `sent to ${input.to}`,
  });
  const approvals = { check: async (digest) => granted.has(digest) };

  const blocked = await registry.invoke({ name: "mail.send", rawArguments: '{"to":"a@example.invalid"}', sessionId: "s1", approvals });
  assert.equal(blocked.status, "approval-required");

  granted.add(blocked.digest);
  const allowed = await registry.invoke({ name: "mail.send", rawArguments: '{"to":"a@example.invalid"}', sessionId: "s1", approvals });
  assert.equal(allowed.status, "completed");

  // Same approval, different recipient: the digest differs, so it is refused.
  const swapped = await registry.invoke({ name: "mail.send", rawArguments: '{"to":"b@example.invalid"}', sessionId: "s1", approvals });
  assert.equal(swapped.status, "approval-required");
  // Same action, different session: also refused.
  const elsewhere = await registry.invoke({ name: "mail.send", rawArguments: '{"to":"a@example.invalid"}', sessionId: "s2", approvals });
  assert.equal(elsewhere.status, "approval-required");

  // Argument order must not change the digest.
  assert.equal(
    actionDigest({ sessionId: "s", tool: "t", input: { a: 1, b: 2 } }),
    actionDigest({ sessionId: "s", tool: "t", input: { b: 2, a: 1 } }),
  );
});

test("tool output is bounded and redacted before it becomes model context", async () => {
  const registry = new ToolRegistry({ policy: () => "allow", redact: (text) => text.replaceAll("hunter2", "[redacted]") });
  registry.register({
    name: "noisy.act", description: "Talks a lot.", capability: "safe", risk: "low",
    timeoutMs: 1000, maxOutputCharacters: 50, requiresApproval: false,
    inputSchema: { type: "object", required: [], properties: {} },
    execute: async () => `hunter2 ${"x".repeat(500)}`,
  });
  const result = await registry.invoke({ name: "noisy.act", rawArguments: "{}", sessionId: "s" });
  assert.equal(result.output.includes("hunter2"), false);
  assert.match(result.output, /output truncated at 50 characters/u);
});

test("repository tools stay inside the repository", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "atlas-repo-tools-"));
  t.after(async () => { await rm(directory, { recursive: true, force: true }); });
  await mkdir(join(directory, "src"), { recursive: true });
  await writeFile(join(directory, "README.md"), "# Title\nsecond line\n", "utf8");
  await writeFile(join(directory, "src", "app.js"), "const marker = 1;\n", "utf8");

  const registry = new ToolRegistry({ policy: () => "allow" });
  registerRepositoryTools(registry);
  const call = (name, args) => registry.invoke({ name, rawArguments: JSON.stringify(args), sessionId: "s", context: { repository: directory } });

  assert.match((await call("repository.list", { depth: 2 })).output.replaceAll("\\", "/"), /src\/app\.js/u);
  assert.match((await call("repository.read", { path: "README.md" })).output, /1\t# Title/u);
  assert.match((await call("repository.search", { query: "marker" })).output.replaceAll("\\", "/"), /src\/app\.js:1/u);
  assert.equal((await call("repository.search", { query: "(", regex: true })).code, "INVALID_INPUT");

  for (const escape of ["../../../etc/passwd", "/etc/passwd", "src/../../outside"]) {
    const result = await call("repository.read", { path: escape });
    assert.equal(result.status, "failed", `${escape} must not be readable`);
    assert.equal(result.code, "PATH_ESCAPES_REPOSITORY");
  }
  assert.throws(() => confineToRepository(null, "x"), /no repository attached/u);
});

test("compaction keeps the objective, decisions, approvals, and tool-call pairs", () => {
  const messages = [
    { role: "system", content: "You are Atlas." },
    { role: "user", content: "OBJECTIVE: migrate the database." },
    ...Array.from({ length: 30 }, (_, index) => ({ role: index % 2 === 0 ? "assistant" : "user", content: `filler ${index} ${"x".repeat(200)}` })),
    { role: "system", pinned: true, content: "APPROVAL: the operator approved dropping table foo." },
    { role: "assistant", content: "", tool_calls: [{ id: "t1", function: { name: "db.migrate", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "t1", content: "migration applied" },
    { role: "assistant", content: "Done." },
  ];
  const result = compactConversation(messages, { maxCharacters: 3_000 });

  assert.equal(result.compacted, true);
  assert.ok(measure(result.messages) <= 3_000);
  const text = result.messages.map((m) => m.content).join("\n");
  assert.match(text, /OBJECTIVE: migrate the database/u, "the objective survives");
  assert.match(text, /APPROVAL: the operator approved dropping table foo/u, "a pinned approval survives");
  assert.match(text, /compacted to fit the context window/u, "the operator is told compaction happened");

  // A retained tool result must still have the assistant call it answers.
  const toolIndex = result.messages.findIndex((m) => m.role === "tool");
  assert.ok(toolIndex > 0);
  assert.ok((result.messages[toolIndex - 1].tool_calls ?? []).some((c) => c.id === "t1"));
});

test("compaction refuses rather than silently truncating what it cannot fit", () => {
  const messages = [{ role: "system", content: "x".repeat(5_000) }];
  assert.throws(() => compactConversation(messages, { maxCharacters: 100 }), ContextTooLargeError);
});

test("attachments are bounded, typed by us, and confined to the repository", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "atlas-attach-"));
  t.after(async () => { await rm(directory, { recursive: true, force: true }); });
  await writeFile(join(directory, "notes.txt"), "hello from a file", "utf8");
  // A 1x1 PNG.
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  await writeFile(join(directory, "shot.png"), png);

  const text = await loadAttachment(normalizeAttachment({ kind: "text", name: "notes.txt", path: join(directory, "notes.txt") }, { root: directory }));
  assert.match(toModelContent(text)[0].text, /hello from a file/u);

  const image = await loadAttachment(normalizeAttachment({ kind: "image", name: "shot.png", path: join(directory, "shot.png") }, { root: directory }));
  const part = toModelContent(image)[0];
  assert.equal(part.type, "image_url");
  assert.match(part.image_url.url, /^data:image\/png;base64,/u, "images travel inline, so nothing is uploaded anywhere");

  assert.throws(() => normalizeAttachment({ kind: "text", path: "/etc/passwd" }, { root: directory }), (e) => e.code === "PATH_ESCAPES_ROOT");
  assert.throws(() => normalizeAttachment({ kind: "video", path: "x" }), (e) => e.code === "UNKNOWN_KIND");
  assert.throws(() => normalizeAttachment({ kind: "image", text: "inline" }), (e) => e.code === "INLINE_NOT_ALLOWED");
  await assert.rejects(
    () => loadAttachment(normalizeAttachment({ kind: "image", name: "x.bmp", path: join(directory, "x.bmp") }, { root: directory })),
    (e) => e instanceof AttachmentError,
  );
});

test("PDF extraction returns text when it can and null when it cannot", () => {
  assert.equal(extractPdfText(Buffer.from("not a pdf at all")), null);
  // An uncompressed PDF content stream, which is what the extractor reads.
  const pdf = Buffer.from("%PDF-1.4\n1 0 obj\nstream\nBT /F1 12 Tf (Quarterly report) Tj ET\nendstream\nendobj\n", "latin1");
  assert.match(extractPdfText(pdf), /Quarterly report/u);
  // A scanned PDF has no text operators at all: say so rather than invent it.
  const scanned = Buffer.from("%PDF-1.4\n1 0 obj\nstream\n\x01\x02\x03binary image data\nendstream\n", "latin1");
  assert.equal(extractPdfText(scanned), null);
});

test("the conversation loop streams incrementally, calls a tool, and answers", async (t) => {
  const registry = openRegistry();
  let toolInput = null;
  registry.register({
    name: "repository.read", description: "Read a file.", capability: "repository.read", risk: "low",
    timeoutMs: 1000, maxOutputCharacters: 500, requiresApproval: false,
    inputSchema: { type: "object", required: ["path"], properties: { path: { type: "string", maxLength: 100 } } },
    execute: async ({ input }) => { toolInput = input; return "file contents: 42"; },
  });

  const { client, seen } = scriptedClient([
    [
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "repository.read", arguments: '{"path":"a.txt"}' } }] } }] },
      doneFrame("tool_calls"),
    ],
    [textFrame("The file "), textFrame("says 42."), doneFrame("stop", { completion_tokens: 5 })],
  ]);

  const executor = createConversationExecutor({ client, registry });
  const { runtime } = await harness(t, { executor, registry });
  const session = runtime.createSession({ title: "Chat", repository: "/tmp/repo", model: "local", executor: "conversation" });
  runtime.submitTurn(session.id, { text: "What does a.txt say?" });
  await runtime.drain();

  assert.equal(runtime.getSession(session.id).status, "completed");
  assert.deepEqual(toolInput, { path: "a.txt" });

  const events = runtime.getEvents(session.id);
  const proposal = events.find((e) => e.kind === "tool_proposal");
  assert.equal(proposal.data.tool, "repository.read");
  assert.equal(proposal.data.capability, "repository.read");
  const execution = events.find((e) => e.kind === "tool_execution");
  assert.equal(execution.data.outcome, "succeeded");
  assert.match(execution.data.summary, /file contents: 42/u);

  const messages = events.filter((e) => e.kind === "assistant_message");
  assert.ok(messages.some((e) => e.data.final === false), "the answer streamed incrementally");
  assert.equal(messages.at(-1).data.final, true);
  assert.equal(messages.at(-1).data.text, "The file says 42.");

  // The tool result was fed back to the model on the second call.
  assert.match(JSON.stringify(seen[1].messages), /file contents: 42/u);
});

test("a platform-backed conversation keeps a durable task identity and lifecycle", async (t) => {
  const registry = openRegistry();
  const { client } = scriptedClient([[textFrame("Ready."), doneFrame("stop")]]);
  const executor = createConversationExecutor({ client, registry });
  const directory = await mkdtemp(join(tmpdir(), "atlas-conv-platform-"));
  const platformStore = new PlatformTaskStore(join(directory, "platform.sqlite"));
  const { runtime } = await harness(t, { executor, registry, platformStore });
  const session = runtime.createSession({ title: "Durable Chat", repository: "/tmp/repo", model: "local", executor: "conversation" });
  assert.match(session.platformTaskId, /^tsk_[0-9a-f]{32}$/u);
  runtime.submitTurn(session.id, { text: "Say ready." });
  await runtime.drain();

  const task = platformStore.getTask("local", session.platformTaskId);
  assert.equal(task.status, "completed");
  assert.deepEqual(platformStore.listTransitions("local", task.id).map((transition) => transition.to), ["authorized", "queued", "running", "verifying", "completed"]);
});

test("a tool needing approval pauses the session and emits an approval request", async (t) => {
  const registry = new ToolRegistry({ policy: () => "allow" });
  registry.register({
    name: "mail.send", description: "Send an email.", capability: "communications", risk: "high",
    timeoutMs: 1000, maxOutputCharacters: 200, requiresApproval: true,
    inputSchema: { type: "object", required: [], properties: {} },
    execute: async () => assert.fail("must not run without approval"),
  });
  const { client } = scriptedClient([[
    { choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "mail.send", arguments: "{}" } }] } }] },
    doneFrame("tool_calls"),
  ]]);

  const executor = createConversationExecutor({ client, registry, approvals: { check: async () => false } });
  const { runtime } = await harness(t, { executor, registry });
  const session = runtime.createSession({ title: "Approval", repository: "/tmp/repo", model: "local", executor: "conversation" });
  runtime.submitTurn(session.id, { text: "Email the team." });
  await runtime.drain();

  assert.equal(runtime.getSession(session.id).status, "awaiting_approval");
  const request = runtime.getEvents(session.id).find((e) => e.kind === "approval_request");
  assert.equal(request.data.capability, "communications");
  assert.match(request.data.actionDigest, /^[0-9a-f]{64}$/u);
});

test("the loop reports an unregistered tool request at critical risk instead of running it", async (t) => {
  const registry = openRegistry();
  const { client } = scriptedClient([
    [
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "shell.exec", arguments: '{"cmd":"rm -rf /"}' } }] } }] },
      doneFrame("tool_calls"),
    ],
    [textFrame("I could not do that."), doneFrame("stop")],
  ]);
  const executor = createConversationExecutor({ client, registry });
  const { runtime } = await harness(t, { executor, registry });
  const session = runtime.createSession({ title: "Rogue", repository: "/tmp/repo", model: "local", executor: "conversation" });
  runtime.submitTurn(session.id, { text: "Delete everything." });
  await runtime.drain();

  const events = runtime.getEvents(session.id);
  assert.equal(events.find((e) => e.kind === "tool_proposal").data.risk, "critical");
  const execution = events.find((e) => e.kind === "tool_execution");
  assert.equal(execution.data.outcome, "failed");
  assert.match(execution.data.summary, /UNKNOWN_TOOL/u);
  assert.equal(runtime.getSession(session.id).status, "completed", "the model was told and carried on");
});

test("the loop stops after its iteration limit instead of looping forever", async (t) => {
  const registry = openRegistry();
  registry.register({
    name: "loop.again", description: "Does nothing.", capability: "safe", risk: "low",
    timeoutMs: 1000, maxOutputCharacters: 100, requiresApproval: false,
    inputSchema: { type: "object", required: [], properties: {} }, execute: async () => "again",
  });
  const { client } = scriptedClient([[
    { choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "loop.again", arguments: "{}" } }] } }] },
    doneFrame("tool_calls"),
  ]]);
  const executor = createConversationExecutor({ client, registry, maxIterations: 3 });
  const { runtime } = await harness(t, { executor, registry });
  const session = runtime.createSession({ title: "Loop", repository: "/tmp/repo", model: "local", executor: "conversation" });
  runtime.submitTurn(session.id, { text: "Go." });
  await runtime.drain();

  assert.equal(runtime.getSession(session.id).status, "failed");
  assert.ok(runtime.getEvents(session.id).some((e) => e.kind === "error" && e.data.code === "ITERATION_LIMIT"));
});

test("inline reasoning is stripped from the answer the loop publishes", async (t) => {
  const registry = openRegistry();
  const { client } = scriptedClient([[
    textFrame("<think>The user's API key is sk-live-123 so I will"),
    textFrame(" avoid mentioning it.</think>"),
    textFrame("Everything looks configured."),
    doneFrame("stop"),
  ]]);
  const executor = createConversationExecutor({ client, registry });
  const { runtime } = await harness(t, { executor, registry });
  const session = runtime.createSession({ title: "Reasoning", repository: "/tmp/repo", model: "local", executor: "conversation" });
  runtime.submitTurn(session.id, { text: "Check the config." });
  await runtime.drain();

  const final = runtime.getEvents(session.id).filter((e) => e.kind === "assistant_message").at(-1);
  assert.equal(final.data.text, "Everything looks configured.");
  assert.equal(final.data.text.includes("sk-live-123"), false);
});

test("regenerate re-answers the same turn without duplicating it", async (t) => {
  const registry = openRegistry();
  let call = 0;
  const client = {
    async *stream() {
      call += 1;
      yield { type: "text", delta: `answer ${call}` };
      yield { type: "done", finishReason: "stop", usage: null };
    },
  };
  const executor = createConversationExecutor({ client, registry });
  const { runtime } = await harness(t, { executor, registry });
  const session = runtime.createSession({ title: "Regen", repository: "/tmp/repo", model: "local", executor: "conversation" });
  runtime.submitTurn(session.id, { text: "Say something." });
  await runtime.drain();
  assert.equal(runtime.getEvents(session.id).filter((e) => e.kind === "assistant_message").at(-1).data.text, "answer 1");

  runtime.regenerate(session.id);
  await runtime.drain();
  assert.equal(runtime.getEvents(session.id).filter((e) => e.kind === "assistant_message").at(-1).data.text, "answer 2");
  assert.equal(runtime.getTurns(session.id).length, 1, "regenerating did not duplicate the question");
});

test("edit-and-resend rewrites a turn and removes the answers that followed it", async (t) => {
  const registry = openRegistry();
  const asked = [];
  const client = {
    async *stream({ messages }) {
      asked.push(messages.at(-1).content);
      yield { type: "text", delta: "ok" };
      yield { type: "done", finishReason: "stop", usage: null };
    },
  };
  const executor = createConversationExecutor({ client, registry });
  const { runtime } = await harness(t, { executor, registry });
  const session = runtime.createSession({ title: "Edit", repository: "/tmp/repo", model: "local", executor: "conversation" });
  const { turn } = runtime.submitTurn(session.id, { text: "First question." });
  await runtime.drain();
  runtime.submitTurn(session.id, { text: "Second question." });
  await runtime.drain();
  assert.equal(runtime.getTurns(session.id).length, 2);

  runtime.editAndResend(session.id, turn.id, { text: "First question, corrected." });
  await runtime.drain();

  const turns = runtime.getTurns(session.id);
  assert.equal(turns.length, 1, "the later turn was removed with its answer");
  assert.equal(turns[0].text, "First question, corrected.");
  assert.equal(asked.at(-1), "First question, corrected.");
  assert.throws(() => runtime.editAndResend(session.id, "not-a-turn", { text: "x" }), (e) => e.code === "UNKNOWN_TURN");
});

test("speech transcription posts multipart audio and rejects what it cannot accept", async () => {
  let sent = null;
  const transcriber = createSpeechTranscriber({
    baseUrl: "http://127.0.0.1:8080/v1",
    model: "whisper-1",
    fetchImpl: async (url, init) => { sent = { url: String(url), init }; return Response.json({ text: "  transcribed words  " }); },
  });

  const result = await transcriber.transcribe({ audio: Buffer.from("fake audio"), mediaType: "audio/webm" });
  assert.equal(result.text, "transcribed words");
  assert.match(sent.url, /audio\/transcriptions$/u);
  assert.match(sent.init.headers["content-type"], /^multipart\/form-data; boundary=atlas/u);
  assert.match(sent.init.body.toString("utf8"), /name="file"; filename="speech\.webm"/u);

  await assert.rejects(() => transcriber.transcribe({ audio: Buffer.from("x"), mediaType: "audio/aiff" }), /not accepted/u);
  await assert.rejects(() => transcriber.transcribe({ audio: Buffer.alloc(0), mediaType: "audio/webm" }), /No audio/u);
  assert.throws(() => createSpeechTranscriber({ baseUrl: "http://speech.example.invalid/v1" }), /HTTPS unless it is loopback/u);
});
