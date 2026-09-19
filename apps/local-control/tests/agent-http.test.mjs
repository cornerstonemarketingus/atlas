import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createLocalControlServer } from "../src/server.mjs";
import { LocalTaskStore } from "../src/store.mjs";
import { AgentSessionStore } from "../src/agent/session-store.mjs";
import { AgentRuntime } from "../src/agent/runtime.mjs";
import { assistantMessageEvent, statusEvent } from "../src/agent/events.mjs";
import { createConversationExecutor } from "../src/agent/conversation-executor.mjs";
import { createRateLimiter, LIMITS } from "../src/rate-limit.mjs";
import { ToolRegistry } from "../src/agent/tool-registry.mjs";

const TOKEN = "0123456789abcdef0123456789abcdef";

async function serve(t, executor, { transcriber = null } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "atlas-agent-http-"));
  const store = new LocalTaskStore(join(directory, "atlas.sqlite"));
  const sessions = new AgentSessionStore(join(directory, "agent.sqlite"));
  const runtime = new AgentRuntime({ sessions, executors: { local: executor }, audit: (category, summary) => store.audit(category, summary) });
  const server = createLocalControlServer({ store, token: TOKEN, runTask: async () => ({ ok: true, message: "" }), runtime, transcriber });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await runtime.stop();
    await new Promise((resolve) => server.close(resolve));
    sessions.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { origin: `http://127.0.0.1:${server.address().port}`, admin: { authorization: `Bearer ${TOKEN}` }, runtime, store };
}

/** Reads server-sent events until `predicate` is satisfied, then disconnects. */
async function readEvents(url, headers, predicate, { timeoutMs = 4_000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const response = await fetch(url, { headers, signal: controller.signal });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/event-stream/u);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const events = [];
  let buffer = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = frame.split("\n").find((line) => line.startsWith("data: "));
        if (data) events.push(JSON.parse(data.slice(6)));
        boundary = buffer.indexOf("\n\n");
      }
      if (predicate(events)) break;
    }
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
  return events;
}

const echoExecutor = {
  id: "local",
  async run({ turn, emit }) {
    emit(statusEvent("Thinking."));
    emit(assistantMessageEvent({ text: `Answered: ${turn.text}`, final: true, turnId: turn.id }));
    return { status: "completed", summary: "Answered." };
  },
};

test("a session runs end to end over HTTP and streams its events", async (t) => {
  const { origin, admin } = await serve(t, echoExecutor);

  const health = await (await fetch(`${origin}/health`)).json();
  assert.deepEqual(health.runtime, { running: true, executors: ["local"] });

  const created = await fetch(`${origin}/v1/sessions`, {
    method: "POST",
    headers: { ...admin, "content-type": "application/json" },
    body: JSON.stringify({ title: "Ship the docs", repository: "/tmp/repo", model: "qwen2.5-coder:7b" }),
  });
  assert.equal(created.status, 201);
  const { session } = await created.json();

  const streamed = readEvents(`${origin}/v1/sessions/${session.id}/events`, admin, (events) => events.some((event) => event.kind === "completion"));
  const turn = await fetch(`${origin}/v1/sessions/${session.id}/turns`, {
    method: "POST",
    headers: { ...admin, "content-type": "application/json" },
    body: JSON.stringify({ text: "Explain the runtime." }),
  });
  assert.equal(turn.status, 202);

  const events = await streamed;
  assert.ok(events.some((event) => event.kind === "assistant_message" && event.data.text === "Answered: Explain the runtime."));
  assert.equal(events.at(-1).data.status, "completed");

  const fetched = await (await fetch(`${origin}/v1/sessions/${session.id}`, { headers: admin })).json();
  assert.equal(fetched.session.status, "completed");
  assert.equal(fetched.turns.length, 1);
});

test("reopening the stream with a cursor replays only what was missed", async (t) => {
  const { origin, admin, runtime } = await serve(t, echoExecutor);
  const { session } = await (await fetch(`${origin}/v1/sessions`, {
    method: "POST",
    headers: { ...admin, "content-type": "application/json" },
    body: JSON.stringify({ title: "Resume", repository: "/tmp/repo", model: "m" }),
  })).json();
  await fetch(`${origin}/v1/sessions/${session.id}/turns`, {
    method: "POST",
    headers: { ...admin, "content-type": "application/json" },
    body: JSON.stringify({ text: "One." }),
  });
  await runtime.drain();

  const all = await readEvents(`${origin}/v1/sessions/${session.id}/events`, admin, (events) => events.some((event) => event.kind === "completion"));
  const cursor = all.at(-2).sequence;
  // `Last-Event-ID` is what a browser sends on its own reconnect.
  const resumed = await readEvents(`${origin}/v1/sessions/${session.id}/events`, { ...admin, "last-event-id": String(cursor) }, (events) => events.length >= 1);
  assert.ok(resumed.every((event) => event.sequence > cursor));
  assert.equal(resumed[0].sequence, cursor + 1);
});

test("a paired device can watch a session but cannot create work", async (t) => {
  const { origin, admin } = await serve(t, echoExecutor);
  const { code } = await (await fetch(`${origin}/v1/pair`, { method: "POST", headers: admin })).json();
  const { deviceToken } = await (await fetch(`${origin}/v1/pair/claim`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, name: "Phone" }),
  })).json();
  const device = { authorization: `Bearer ${deviceToken}` };

  const { session } = await (await fetch(`${origin}/v1/sessions`, {
    method: "POST",
    headers: { ...admin, "content-type": "application/json" },
    body: JSON.stringify({ title: "Owned", repository: "/tmp/repo", model: "m" }),
  })).json();

  assert.equal((await fetch(`${origin}/v1/sessions`, { headers: device })).status, 200);
  assert.equal((await fetch(`${origin}/v1/sessions/${session.id}`, { headers: device })).status, 200);
  for (const [path, body] of [["turns", { text: "do it" }], ["control", { action: "cancel" }]]) {
    const response = await fetch(`${origin}/v1/sessions/${session.id}/${path}`, {
      method: "POST",
      headers: { ...device, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 403, `a device must not be able to POST ${path}`);
  }
  const anonymous = await fetch(`${origin}/v1/sessions/${session.id}/events`);
  assert.equal(anonymous.status, 401);
});

test("control actions are validated and reported over HTTP", async (t) => {
  let release;
  const blocked = {
    id: "local",
    async run({ signal }) {
      await new Promise((resolve) => { release = resolve; signal.addEventListener("abort", () => resolve(), { once: true }); });
      return { status: "completed", summary: "done" };
    },
  };
  const { origin, admin, runtime } = await serve(t, blocked);
  const { session } = await (await fetch(`${origin}/v1/sessions`, {
    method: "POST",
    headers: { ...admin, "content-type": "application/json" },
    body: JSON.stringify({ title: "Control", repository: "/tmp/repo", model: "m" }),
  })).json();

  const bad = await fetch(`${origin}/v1/sessions/${session.id}/control`, {
    method: "POST",
    headers: { ...admin, "content-type": "application/json" },
    body: JSON.stringify({ action: "self-destruct" }),
  });
  assert.equal(bad.status, 400);

  const notRunning = await fetch(`${origin}/v1/sessions/${session.id}/control`, {
    method: "POST",
    headers: { ...admin, "content-type": "application/json" },
    body: JSON.stringify({ action: "pause" }),
  });
  assert.equal(notRunning.status, 409);

  await fetch(`${origin}/v1/sessions/${session.id}/turns`, {
    method: "POST",
    headers: { ...admin, "content-type": "application/json" },
    body: JSON.stringify({ text: "Long job." }),
  });
  while (!release) await new Promise((resolve) => setTimeout(resolve, 5));

  const cancelled = await fetch(`${origin}/v1/sessions/${session.id}/control`, {
    method: "POST",
    headers: { ...admin, "content-type": "application/json" },
    body: JSON.stringify({ action: "cancel" }),
  });
  assert.equal(cancelled.status, 200);
  await runtime.drain();
  assert.equal(runtime.getSession(session.id).status, "cancelled");

  const missing = await fetch(`${origin}/v1/sessions/00000000-0000-4000-8000-000000000000`, { headers: admin });
  assert.equal(missing.status, 404);
});

test("session input is bounded and every event lands in the audit timeline", async (t) => {
  const { origin, admin, store } = await serve(t, echoExecutor);
  const invalid = await fetch(`${origin}/v1/sessions`, {
    method: "POST",
    headers: { ...admin, "content-type": "application/json" },
    body: JSON.stringify({ title: "", model: "" }),
  });
  assert.equal(invalid.status, 400);

  const { session } = await (await fetch(`${origin}/v1/sessions`, {
    method: "POST",
    headers: { ...admin, "content-type": "application/json" },
    body: JSON.stringify({ title: "Audited", repository: "/tmp/repo", model: "m" }),
  })).json();
  const emptyTurn = await fetch(`${origin}/v1/sessions/${session.id}/turns`, {
    method: "POST",
    headers: { ...admin, "content-type": "application/json" },
    body: JSON.stringify({ text: "   " }),
  });
  assert.equal(emptyTurn.status, 400);

  await fetch(`${origin}/v1/sessions/${session.id}/turns`, {
    method: "POST",
    headers: { ...admin, "content-type": "application/json" },
    body: JSON.stringify({ text: "Record this." }),
  });
  await new Promise((resolve) => setTimeout(resolve, 100));

  const audit = await (await fetch(`${origin}/v1/audit`, { headers: admin })).json();
  const agentEvents = audit.events.filter((event) => event.category.startsWith("agent."));
  assert.ok(agentEvents.some((event) => event.category === "agent.completion"));
  assert.ok(agentEvents.every((event) => event.summary.includes(session.id)));
});

test("session routes answer 503 when no runtime is attached", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "atlas-no-runtime-"));
  const store = new LocalTaskStore(join(directory, "atlas.sqlite"));
  const server = createLocalControlServer({ store, token: TOKEN, runTask: async () => ({ ok: true, message: "" }) });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { await new Promise((resolve) => server.close(resolve)); store.close(); await rm(directory, { recursive: true, force: true }); });

  const origin = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(`${origin}/v1/sessions`, { headers: { authorization: `Bearer ${TOKEN}` } });
  assert.equal(response.status, 503);
  const health = await (await fetch(`${origin}/health`)).json();
  assert.equal(health.runtime.running, false);
});

test("the local UI script is syntactically valid and wired to the session API", async () => {
  const { LOCAL_UI_HTML, LOCAL_UI_JS } = await import("../src/ui.mjs");
  // The script is shipped as a string, so a syntax error in it is invisible to
  // `node --check` and would only surface in the browser. Parse it here.
  assert.doesNotThrow(() => new Function(LOCAL_UI_JS));

  for (const endpoint of ["/v1/sessions", "/v1/executors", "/turns", "/control", "/events?after=", "/v1/transcribe"]) {
    assert.ok(LOCAL_UI_JS.includes(endpoint), `the UI calls ${endpoint}`);
  }
  for (const id of ["transcript", "turn-form", "session-picker", "pause", "resume", "stop", "retry", "regenerate", "edit-last", "dictate", "attachments"]) {
    assert.ok(LOCAL_UI_HTML.includes(`id="${id}"`), `the UI renders #${id}`);
    assert.ok(LOCAL_UI_JS.includes(`#${id}`), `the UI script binds #${id}`);
  }
  // The bearer token must never travel in a URL, where it would be logged.
  assert.equal(/access_token=|token=|new EventSource/u.test(LOCAL_UI_JS), false);
});


test("dictation is owner-only, bounded, and absent until an endpoint is configured", async (t) => {
  const unconfigured = await serve(t, echoExecutor);
  const missing = await fetch(`${unconfigured.origin}/v1/transcribe`, {
    method: "POST",
    headers: { ...unconfigured.admin, "content-type": "audio/webm" },
    body: Buffer.from("audio"),
  });
  assert.equal(missing.status, 503, "no transcription endpoint means a clear 503, not a crash");

  const transcriber = { transcribe: async ({ audio, mediaType }) => ({ text: `${mediaType}:${audio.length}` }) };
  const { origin, admin } = await serve(t, echoExecutor, { transcriber });

  const ok = await fetch(`${origin}/v1/transcribe`, {
    method: "POST",
    headers: { ...admin, "content-type": "audio/webm" },
    body: Buffer.from("some audio"),
  });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).text, "audio/webm:10");

  const empty = await fetch(`${origin}/v1/transcribe`, { method: "POST", headers: { ...admin, "content-type": "audio/webm" } });
  assert.equal(empty.status, 400);

  const { code } = await (await fetch(`${origin}/v1/pair`, { method: "POST", headers: admin })).json();
  const { deviceToken } = await (await fetch(`${origin}/v1/pair/claim`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, name: "Phone" }),
  })).json();
  const denied = await fetch(`${origin}/v1/transcribe`, {
    method: "POST",
    headers: { authorization: `Bearer ${deviceToken}`, "content-type": "audio/webm" },
    body: Buffer.from("audio"),
  });
  assert.equal(denied.status, 403, "a paired device cannot spend the owner's transcription endpoint");
});


test("an approval travels from the model, to the operator, and back into the run", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "atlas-approval-e2e-"));
  const store = new LocalTaskStore(join(directory, "atlas.sqlite"));
  const sessions = new AgentSessionStore(join(directory, "agent.sqlite"));

  const sent = [];
  const registry = new ToolRegistry({ policy: () => "allow" });
  registry.register({
    name: "mail.send",
    description: "Send an email to the team.",
    capability: "communications.send",
    risk: "critical",
    timeoutMs: 5_000,
    maxOutputCharacters: 500,
    requiresApproval: true,
    inputSchema: { type: "object", required: ["to"], properties: { to: { type: "string", maxLength: 200 } } },
    execute: async ({ input }) => { sent.push(input.to); return `sent to ${input.to}`; },
  });

  // The model asks for the tool, then — once it has the result — answers.
  let round = 0;
  const client = {
    async *stream() {
      round += 1;
      if (round === 1 || round === 2) {
        yield { type: "tool_call", id: `c${round}`, name: "mail.send", arguments: '{"to":"team@example.invalid"}' };
      } else {
        yield { type: "text", delta: "Sent." };
      }
      yield { type: "done", finishReason: "stop", usage: null };
    },
  };

  const executor = createConversationExecutor({
    client,
    registry,
    approvals: {
      check: (digest) => store.consumeApprovedDigest(digest),
      request: ({ digest, capability, summary, sessionId }) => store.createApproval({ capability, summary, actionDigest: digest, sessionId }),
    },
  });

  const runtime = new AgentRuntime({ sessions, executors: { conversation: executor }, audit: (c, m) => store.audit(c, m) });
  const server = createLocalControlServer({ store, token: TOKEN, runTask: async () => ({ ok: true, message: "" }), runtime });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await runtime.stop();
    await new Promise((resolve) => server.close(resolve));
    sessions.close(); store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const admin = { authorization: `Bearer ${TOKEN}` };

  const { session } = await (await fetch(`${origin}/v1/sessions`, {
    method: "POST",
    headers: { ...admin, "content-type": "application/json" },
    body: JSON.stringify({ title: "Outreach", repository: "/tmp/repo", model: "local", executor: "conversation" }),
  })).json();

  await fetch(`${origin}/v1/sessions/${session.id}/turns`, {
    method: "POST",
    headers: { ...admin, "content-type": "application/json" },
    body: JSON.stringify({ text: "Email the team." }),
  });
  await runtime.drain();

  assert.equal(runtime.getSession(session.id).status, "awaiting_approval");
  assert.equal(sent.length, 0, "nothing was sent while waiting");

  // The operator sees exactly one pending approval, carrying the action digest.
  const pending = (await (await fetch(`${origin}/v1/approvals`, { headers: admin })).json()).approvals.filter((a) => a.status === "pending");
  assert.equal(pending.length, 1);
  assert.equal(pending[0].sessionId, session.id);
  assert.match(pending[0].actionDigest, /^[0-9a-f]{64}$/u);
  assert.match(pending[0].summary, /mail\.send/u);

  const decided = await fetch(`${origin}/v1/approvals/${pending[0].id}/decision`, {
    method: "POST",
    headers: { ...admin, "content-type": "application/json" },
    body: JSON.stringify({ decision: "approved" }),
  });
  assert.equal(decided.status, 200);
  await new Promise((resolve) => setTimeout(resolve, 60));
  await runtime.drain();

  assert.deepEqual(sent, ["team@example.invalid"], "the approved action ran exactly once");
  assert.equal(runtime.getSession(session.id).status, "completed");
  // The approval was spent: the same digest cannot authorize a second send.
  assert.equal(store.consumeApprovedDigest(pending[0].actionDigest), false);
});

test("a denied approval stops the session instead of letting it retry", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "atlas-denial-"));
  const store = new LocalTaskStore(join(directory, "atlas.sqlite"));
  const sessions = new AgentSessionStore(join(directory, "agent.sqlite"));

  let executions = 0;
  const registry = new ToolRegistry({ policy: () => "allow" });
  registry.register({
    name: "repo.delete_all", description: "Delete everything.", capability: "repository.write", risk: "critical",
    timeoutMs: 5_000, maxOutputCharacters: 200, requiresApproval: true,
    inputSchema: { type: "object", required: [], properties: {} },
    execute: async () => { executions += 1; return "deleted"; },
  });
  const client = {
    async *stream() {
      yield { type: "tool_call", id: "c1", name: "repo.delete_all", arguments: "{}" };
      yield { type: "done", finishReason: "stop", usage: null };
    },
  };
  const executor = createConversationExecutor({
    client, registry,
    approvals: {
      check: (digest) => store.consumeApprovedDigest(digest),
      request: ({ digest, capability, summary, sessionId }) => store.createApproval({ capability, summary, actionDigest: digest, sessionId }),
    },
  });
  const runtime = new AgentRuntime({ sessions, executors: { conversation: executor }, audit: (c, m) => store.audit(c, m) });
  const server = createLocalControlServer({ store, token: TOKEN, runTask: async () => ({ ok: true, message: "" }), runtime });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await runtime.stop();
    await new Promise((resolve) => server.close(resolve));
    sessions.close(); store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const admin = { authorization: `Bearer ${TOKEN}` };

  const { session } = await (await fetch(`${origin}/v1/sessions`, {
    method: "POST", headers: { ...admin, "content-type": "application/json" },
    body: JSON.stringify({ title: "Risky", repository: "/tmp/repo", model: "local", executor: "conversation" }),
  })).json();
  await fetch(`${origin}/v1/sessions/${session.id}/turns`, {
    method: "POST", headers: { ...admin, "content-type": "application/json" },
    body: JSON.stringify({ text: "Clean up the repo." }),
  });
  await runtime.drain();

  const pending = (await (await fetch(`${origin}/v1/approvals`, { headers: admin })).json()).approvals.find((a) => a.status === "pending");
  await fetch(`${origin}/v1/approvals/${pending.id}/decision`, {
    method: "POST", headers: { ...admin, "content-type": "application/json" },
    body: JSON.stringify({ decision: "denied" }),
  });
  await new Promise((resolve) => setTimeout(resolve, 60));
  await runtime.drain();

  assert.equal(executions, 0, "a denied action never ran");
  assert.equal(runtime.getSession(session.id).status, "cancelled");
  const completion = runtime.getEvents(session.id).at(-1);
  assert.equal(completion.data.status, "denied");
});


test("the rate limiter counts per client and per bucket, and forgives success", () => {
  let clock = 0;
  const limiter = createRateLimiter({ now: () => clock });

  for (let attempt = 0; attempt < LIMITS.pairing.limit; attempt += 1) {
    assert.equal(limiter.check({ bucket: "pairing", client: "10.0.0.1", ...LIMITS.pairing }).allowed, true);
  }
  const blocked = limiter.check({ bucket: "pairing", client: "10.0.0.1", ...LIMITS.pairing });
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.retryAfterSeconds > 0 && blocked.retryAfterSeconds <= 60);

  // A different client is unaffected, and so is a different endpoint.
  assert.equal(limiter.check({ bucket: "pairing", client: "10.0.0.2", ...LIMITS.pairing }).allowed, true);
  assert.equal(limiter.check({ bucket: "approval", client: "10.0.0.1", ...LIMITS.approval }).allowed, true);

  // The window rolls.
  clock += 60_001;
  assert.equal(limiter.check({ bucket: "pairing", client: "10.0.0.1", ...LIMITS.pairing }).allowed, true);

  // A success clears the count, so a correct code is not punished.
  limiter.check({ bucket: "pairing", client: "10.0.0.3", ...LIMITS.pairing });
  limiter.clear({ bucket: "pairing", client: "10.0.0.3" });
  for (let attempt = 0; attempt < LIMITS.pairing.limit; attempt += 1) {
    assert.equal(limiter.check({ bucket: "pairing", client: "10.0.0.3", ...LIMITS.pairing }).allowed, true);
  }
});

test("approval decisions are rate limited and cannot be replayed", async (t) => {
  const { origin, admin, store } = await serve(t, echoExecutor);

  // Well past the approval limit, so the sweep is cut off.
  let limited = 0;
  let answered = 0;
  for (let attempt = 0; attempt < LIMITS.approval.limit + 5; attempt += 1) {
    const response = await fetch(`${origin}/v1/approvals/00000000-0000-4000-8000-00000000000${attempt % 10}/decision`, {
      method: "POST",
      headers: { ...admin, "content-type": "application/json" },
      body: JSON.stringify({ decision: "approved" }),
    });
    if (response.status === 429) {
      limited += 1;
      assert.ok(Number(response.headers.get("retry-after")) > 0, "a 429 says when to try again");
    } else {
      answered += 1;
    }
  }
  assert.ok(limited > 0, "sweeping for approval identifiers is cut off");
  assert.equal(answered, LIMITS.approval.limit, "the limit is exactly what it says");

  // Replay protection: an approval can only be decided once.
  const approval = store.createApproval({ capability: "code.write", summary: "Do the thing", actionDigest: "a".repeat(64) });
  assert.equal(store.decideApproval(approval.id, "approved").status, "approved");
  assert.equal(store.decideApproval(approval.id, "denied"), null, "a decided approval cannot be decided again");

  // And the digest it authorizes is spendable exactly once.
  assert.equal(store.consumeApprovedDigest("a".repeat(64)), true);
  assert.equal(store.consumeApprovedDigest("a".repeat(64)), false);
});
