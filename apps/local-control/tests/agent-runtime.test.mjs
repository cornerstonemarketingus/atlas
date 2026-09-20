import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AgentSessionStore } from "../src/agent/session-store.mjs";
import { AgentRuntime, AgentRuntimeError } from "../src/agent/runtime.mjs";
import { BudgetExceededError, BudgetLedger, normalizeBudget } from "../src/agent/budget.mjs";
import { AgentEventError, assistantMessageEvent, normalizeAgentEvent, statusEvent } from "../src/agent/events.mjs";
import { createGitHubActionsExecutor, createLocalExecutor } from "../src/agent/executors.mjs";
import { createGitHubActionsClient } from "../src/agent/github-actions-client.mjs";

async function harness(t, { executors, ...options } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "atlas-agent-"));
  const sessions = new AgentSessionStore(join(directory, "agent.sqlite"));
  const audit = [];
  const runtime = new AgentRuntime({
    sessions,
    executors: executors ?? { local: completingExecutor() },
    audit: (category, summary) => audit.push({ category, summary }),
    ...options,
  });
  t.after(async () => {
    await runtime.stop();
    sessions.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, sessions, runtime, audit };
}

function completingExecutor(text = "Done.") {
  return {
    id: "local",
    async run({ turn, emit }) {
      emit(statusEvent("Working."));
      emit(assistantMessageEvent({ text, final: true, turnId: turn.id }));
      return { status: "completed", summary: text };
    },
  };
}

/** Blocks until the test releases it, so pause/cancel have something to interrupt. */
function controllableExecutor() {
  const state = { started: null, release: null, sawAbort: false, checkpoints: 0, runs: 0 };
  const executor = {
    id: "local",
    async run({ emit, signal, checkpoint }) {
      state.runs += 1;
      emit(statusEvent("Started."));
      await new Promise((resolve) => {
        state.release = resolve;
        signal.addEventListener("abort", () => { state.sawAbort = true; resolve(); }, { once: true });
        state.started?.();
      });
      state.checkpoints += 1;
      await checkpoint();
      emit(assistantMessageEvent({ text: "Finished.", final: true, turnId: null }));
      return { status: "completed", summary: "Finished." };
    },
  };
  return { executor, state };
}

const waitFor = async (predicate, timeoutMs = 2_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for a condition.");
};

test("event contract fails closed on unknown kinds and oversized payloads", () => {
  assert.equal(normalizeAgentEvent({ kind: "status", data: { summary: "hi" } }).schemaVersion, 1);
  assert.throws(() => normalizeAgentEvent({ kind: "whatever", data: {} }), AgentEventError);
  assert.throws(() => normalizeAgentEvent({ kind: "status", data: "not an object" }), AgentEventError);
  assert.throws(() => normalizeAgentEvent({ kind: "status", data: { summary: "x".repeat(200_000) } }), AgentEventError);
  const cyclic = {};
  cyclic.self = cyclic;
  assert.throws(() => normalizeAgentEvent({ kind: "status", data: cyclic }), AgentEventError);
});

test("budgets reject the whole increment that would cross a limit", () => {
  const ledger = new BudgetLedger({ limits: { toolCalls: 2, outputTokens: 10 } });
  ledger.record({ toolCalls: 1, outputTokens: 4 });
  assert.throws(() => ledger.record({ toolCalls: 1, outputTokens: 40 }), BudgetExceededError);
  // The refused increment charged nothing, including its within-limit part.
  assert.equal(ledger.used.toolCalls, 1);
  assert.equal(ledger.used.outputTokens, 4);
  ledger.record({ toolCalls: 1 });
  assert.equal(ledger.exhausted(), true);
  assert.throws(() => normalizeBudget({ nonsense: 1 }), /Unknown budget dimension/u);
  assert.throws(() => normalizeBudget({ toolCalls: -1 }), /non-negative/u);
});

test("the event log allocates gap-free sequences and replays from a cursor", async (t) => {
  const { sessions } = await harness(t);
  const session = sessions.createSession({ title: "Log", model: "local" });
  for (let index = 0; index < 5; index += 1) sessions.appendEvent(session.id, statusEvent(`event ${index}`));
  assert.deepEqual(sessions.events(session.id).map((event) => event.sequence), [1, 2, 3, 4, 5]);
  assert.deepEqual(sessions.events(session.id, 3).map((event) => event.data.summary), ["event 3", "event 4"]);
  assert.equal(sessions.session(session.id).lastSequence, 5);
});

test("a coding session completes locally with no GitHub executor registered", async (t) => {
  const { runtime, audit } = await harness(t);
  assert.deepEqual(runtime.executorIds(), ["local"]);
  const session = runtime.createSession({ title: "Local only", repository: "/tmp/x", model: "qwen2.5-coder:7b" });
  runtime.submitTurn(session.id, { text: "Add a README section." });
  await runtime.drain();

  const finished = runtime.getSession(session.id);
  assert.equal(finished.status, "completed");
  const events = runtime.getEvents(session.id);
  assert.equal(events.at(-1).kind, "completion");
  assert.equal(events.at(-1).data.status, "completed");
  assert.ok(events.some((event) => event.kind === "assistant_message" && event.data.text === "Done."));
  // Every action reaches the audit timeline, not just the terminal one.
  assert.equal(audit.length, events.length);
  assert.ok(audit.every((entry) => entry.category.startsWith("agent.")));
});

test("an unregistered executor is refused at creation and at run time", async (t) => {
  const { runtime, sessions } = await harness(t);
  assert.throws(() => runtime.createSession({ title: "Remote", model: "m", executor: "github-actions" }), AgentRuntimeError);
  // A session written before an executor was removed must fail closed, not run somewhere else.
  const orphan = sessions.createSession({ title: "Orphan", model: "m", executor: "removed-vendor" });
  runtime.submitTurn(orphan.id, { text: "go" });
  await runtime.drain();
  assert.equal(runtime.getSession(orphan.id).status, "failed");
  assert.ok(runtime.getEvents(orphan.id).some((event) => event.kind === "error" && event.data.code === "UNKNOWN_EXECUTOR"));
});

test("reconnecting mid-run replays the gap without duplicates", async (t) => {
  const { executor, state } = controllableExecutor();
  const { runtime } = await harness(t, { executors: { local: executor } });
  const session = runtime.createSession({ title: "Reconnect", repository: "/tmp/x", model: "m" });

  const first = [];
  const stopFirst = runtime.subscribe(session.id, 0, (event) => first.push(event));
  runtime.submitTurn(session.id, { text: "Start work." });
  await waitFor(() => first.some((event) => event.data.summary === "Started."));

  // The UI is closed mid-run.
  stopFirst();
  const cursor = first.at(-1).sequence;
  state.release();

  const second = [];
  const stopSecond = runtime.subscribe(session.id, cursor, (event) => second.push(event));
  await runtime.drain();
  stopSecond();

  assert.ok(second.length > 0, "the reopened client received the events it missed");
  assert.ok(second.every((event) => event.sequence > cursor), "no event before the cursor was resent");
  const sequences = second.map((event) => event.sequence);
  assert.deepEqual(sequences, [...new Set(sequences)], "no event was delivered twice");
  // The union of both connections is the whole log, with nothing skipped.
  const seen = [...first, ...second].map((event) => event.sequence);
  assert.deepEqual(seen, runtime.getEvents(session.id).map((event) => event.sequence));
  assert.equal(runtime.getSession(session.id).status, "completed");
});

test("cancelling aborts the running tool and stops the session", async (t) => {
  const { executor, state } = controllableExecutor();
  const { runtime } = await harness(t, { executors: { local: executor } });
  const session = runtime.createSession({ title: "Cancel", repository: "/tmp/x", model: "m" });
  runtime.submitTurn(session.id, { text: "Long job." });
  await waitFor(() => state.release !== null);

  runtime.cancel(session.id);
  await runtime.drain();

  assert.equal(state.sawAbort, true, "the executor's abort signal fired");
  const finished = runtime.getSession(session.id);
  assert.equal(finished.status, "cancelled");
  const completion = runtime.getEvents(session.id).at(-1);
  assert.equal(completion.kind, "completion");
  assert.equal(completion.data.status, "cancelled");
  // The interrupted turn went back on the queue so it can be retried.
  assert.equal(runtime.getTurns(session.id)[0].state, "pending");
});

test("pause suspends at the next checkpoint and resume finishes the run", async (t) => {
  const { executor, state } = controllableExecutor();
  const { runtime } = await harness(t, { executors: { local: executor } });
  const session = runtime.createSession({ title: "Pause", repository: "/tmp/x", model: "m" });
  runtime.submitTurn(session.id, { text: "Work." });
  await waitFor(() => state.release !== null);

  runtime.pause(session.id);
  // Pause is honest: it is only "paused" once the run actually stops.
  assert.equal(runtime.getSession(session.id).status, "running");
  state.release();
  await waitFor(() => runtime.getSession(session.id).status === "paused");
  assert.equal(state.sawAbort, false, "pausing did not abort in-flight work");

  runtime.resume(session.id);
  await runtime.drain();
  assert.equal(runtime.getSession(session.id).status, "completed");
});

test("pausing a session that is not running is refused", async (t) => {
  const { runtime } = await harness(t);
  const session = runtime.createSession({ title: "Idle", model: "m" });
  assert.throws(() => runtime.pause(session.id), (error) => error.code === "NOT_RUNNING");
  assert.throws(() => runtime.resume("00000000-0000-4000-8000-000000000000"), (error) => error.code === "UNKNOWN_SESSION");
});

test("a spent time budget stops the run and is reported as a budget failure", async (t) => {
  const executor = {
    id: "local",
    async run({ emit, checkpoint }) {
      emit(statusEvent("Grinding."));
      for (;;) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        await checkpoint();
      }
    },
  };
  const { runtime } = await harness(t, { executors: { local: executor } });
  const session = runtime.createSession({ title: "Timeout", repository: "/tmp/x", model: "m", budget: { elapsedMs: 60 } });
  runtime.submitTurn(session.id, { text: "Never ends." });
  await runtime.drain();

  const finished = runtime.getSession(session.id);
  assert.equal(finished.status, "failed");
  assert.match(finished.summary, /time budget/iu);
  assert.equal(finished.usage.elapsedMs, 60, "the spent budget was persisted, so a resume does not get a fresh hour");
  // The usage a client is told about is the usage that was actually recorded.
  const completion = runtime.getEvents(session.id).at(-1);
  assert.deepEqual(completion.data.usage, finished.usage);
});

test("an exceeded tool-call budget fails the run without further tool calls", async (t) => {
  let calls = 0;
  const executor = {
    id: "local",
    async run({ budget }) {
      for (;;) {
        budget.record({ toolCalls: 1 });
        calls += 1;
      }
    },
  };
  const { runtime } = await harness(t, { executors: { local: executor } });
  const session = runtime.createSession({ title: "Tool budget", repository: "/tmp/x", model: "m", budget: { toolCalls: 3 } });
  runtime.submitTurn(session.id, { text: "Loop." });
  await runtime.drain();

  assert.equal(calls, 3);
  assert.equal(runtime.getSession(session.id).status, "failed");
  assert.ok(runtime.getEvents(session.id).some((event) => event.kind === "error" && event.data.code === "BUDGET_EXCEEDED"));
});

test("retry re-runs the turn that failed", async (t) => {
  let attempt = 0;
  const executor = {
    id: "local",
    async run({ emit, turn }) {
      attempt += 1;
      if (attempt === 1) return { status: "failed", summary: "Transient failure." };
      emit(assistantMessageEvent({ text: "Second time.", final: true, turnId: turn.id }));
      return { status: "completed", summary: "Recovered." };
    },
  };
  const { runtime } = await harness(t, { executors: { local: executor } });
  const session = runtime.createSession({ title: "Retry", repository: "/tmp/x", model: "m" });
  runtime.submitTurn(session.id, { text: "Do the thing." });
  await runtime.drain();
  assert.equal(runtime.getSession(session.id).status, "failed");

  runtime.retry(session.id);
  await runtime.drain();
  assert.equal(attempt, 2);
  assert.equal(runtime.getSession(session.id).status, "completed");
  assert.equal(runtime.getTurns(session.id).length, 1, "retry re-ran the same turn instead of inventing a new one");
});

test("restarting the daemon marks interrupted work and resumes it safely", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "atlas-restart-"));
  const sessions = new AgentSessionStore(join(directory, "agent.sqlite"));
  t.after(async () => { sessions.close(); await rm(directory, { recursive: true, force: true }); });

  // A previous process left a session running and its lease has lapsed.
  const session = sessions.createSession({ title: "Crashed", repository: "/tmp/x", model: "m", status: "running" });
  const turn = sessions.addTurn({ sessionId: session.id, role: "user", text: "Half-finished work." });
  sessions.setTurnState(turn.id, "running");
  sessions.acquireLease(session.id, "dead-runtime", new Date(Date.now() - 60_000).toISOString());

  const runtime = new AgentRuntime({ sessions, executors: { local: completingExecutor("Recovered.") } });
  t.after(async () => { await runtime.stop(); });
  assert.deepEqual(runtime.recover(), [session.id]);

  const recovered = runtime.getSession(session.id);
  assert.equal(recovered.status, "interrupted");
  assert.equal(recovered.leaseOwner, null, "the dead runtime's lease was cleared");
  assert.equal(sessions.turns(session.id)[0].state, "pending", "the in-flight turn went back on the queue");

  runtime.resume(session.id);
  await runtime.drain();
  assert.equal(runtime.getSession(session.id).status, "completed");
});

test("a second runtime declines a session another runtime holds", async (t) => {
  const { sessions, runtime } = await harness(t, { executors: { local: completingExecutor() } });
  const session = runtime.createSession({ title: "Leased", repository: "/tmp/x", model: "m" });
  // A live runtime elsewhere holds the lease for the next minute.
  sessions.acquireLease(session.id, "other-runtime", new Date(Date.now() + 60_000).toISOString());

  runtime.submitTurn(session.id, { text: "Work." });
  await runtime.drain();
  assert.equal(sessions.session(session.id).leaseOwner, "other-runtime", "the lease was not stolen");
  assert.ok(runtime.getEvents(session.id).some((event) => /holds this session's lease/u.test(event.data.summary ?? "")));
});

test("turns submitted while a run is in flight are answered in order", async (t) => {
  const answered = [];
  const executor = {
    id: "local",
    async run({ turn }) {
      answered.push(turn.text);
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { status: "completed", summary: turn.text };
    },
  };
  const { runtime } = await harness(t, { executors: { local: executor } });
  const session = runtime.createSession({ title: "Conversation", repository: "/tmp/x", model: "m" });
  runtime.submitTurn(session.id, { text: "first" });
  runtime.submitTurn(session.id, { text: "second" });
  runtime.submitTurn(session.id, { text: "third" });
  await runtime.drain();

  assert.deepEqual(answered, ["first", "second", "third"]);
  assert.equal(runtime.getSession(session.id).status, "completed");
});

test("the local executor reports its worktree patch as an artifact", async (t) => {
  const runCoder = async (task, options) => {
    assert.equal(task.objective, "Ship it.");
    assert.ok(options.signal, "the executor passes a cancellation signal to the coder");
    return { ok: true, message: "verified", worktree: "/w", patch: "/w/1.patch", patchBytes: 12 };
  };
  const { runtime } = await harness(t, { executors: { local: createLocalExecutor({ runCoder, dataDirectory: "/tmp" }) } });
  const session = runtime.createSession({ title: "Artifact", repository: "/tmp/repo", model: "m" });
  runtime.submitTurn(session.id, { text: "Ship it." });
  await runtime.drain();

  const events = runtime.getEvents(session.id);
  const artifact = events.find((event) => event.kind === "artifact");
  assert.equal(artifact.data.path, "/w/1.patch");
  assert.ok(events.some((event) => event.kind === "tool_proposal" && event.data.capability === "code.write"));
  assert.ok(events.some((event) => event.kind === "validation_result" && event.data.outcome === "passed"));
  assert.equal(runtime.getSession(session.id).status, "completed");
});

test("the local executor refuses a session with no repository", async (t) => {
  const { runtime } = await harness(t, { executors: { local: createLocalExecutor({ runCoder: async () => assert.fail("must not run"), dataDirectory: "/tmp" }) } });
  const session = runtime.createSession({ title: "No repo", model: "m" });
  runtime.submitTurn(session.id, { text: "Do something." });
  await runtime.drain();
  assert.equal(runtime.getSession(session.id).status, "failed");
});

test("an unconfigured GitHub Actions executor fails closed with an actionable message", async (t) => {
  const { runtime } = await harness(t, { executors: { "github-actions": createGitHubActionsExecutor({}) } });
  const session = runtime.createSession({ title: "Remote", repository: "owner/name", model: "m", executor: "github-actions" });
  runtime.submitTurn(session.id, { text: "Run remotely." });
  await runtime.drain();

  const finished = runtime.getSession(session.id);
  assert.equal(finished.status, "failed");
  assert.match(finished.summary, /not configured/u);
});

test("the GitHub Actions executor streams a remote run to completion", async (t) => {
  const statuses = ["queued", "running", "completed"];
  let polls = 0;
  const executor = createGitHubActionsExecutor({
    dispatch: async () => ({ id: 42, status: "queued", url: "https://example.invalid/run/42" }),
    poll: async () => ({ id: 42, status: statuses[Math.min(polls++, statuses.length - 1)], url: "https://example.invalid/run/42" }),
    pollIntervalMs: 1,
  });
  const { runtime } = await harness(t, { executors: { "github-actions": executor } });
  const session = runtime.createSession({ title: "Remote", repository: "owner/name", model: "m", executor: "github-actions" });
  runtime.submitTurn(session.id, { text: "Run remotely." });
  await runtime.drain();

  assert.equal(runtime.getSession(session.id).status, "completed");
  assert.ok(runtime.getEvents(session.id).some((event) => event.kind === "tool_execution" && event.data.tool === "github.workflow_dispatch"));
});

test("the GitHub Actions client dispatches and reads back only its own run", async (t) => {
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url, method: init.method ?? "GET" });
    if (String(url).endsWith("/dispatches")) return new Response(null, { status: 204 });
    return Response.json({
      workflow_runs: [
        { id: 7, status: "in_progress", conclusion: null, html_url: "https://example.invalid/7", created_at: "2999-01-01T00:00:00Z" },
        { id: 6, status: "completed", conclusion: "success", html_url: "https://example.invalid/6", created_at: "1999-01-01T00:00:00Z" },
      ],
    });
  };
  const client = createGitHubActionsClient({ token: "t", repository: "owner/name", workflow: "atlas-coder.yml", fetchImpl });
  const run = await client.dispatch({ objective: "x", model: "m" });
  assert.equal(run.id, 7, "an older run belonging to someone else was not claimed");
  assert.equal(run.status, "running");
  assert.equal(requests[0].method, "POST");
  assert.throws(() => createGitHubActionsClient({ token: "t", repository: "not-a-repo", workflow: "w" }), /owner\/name form/u);
  assert.throws(() => createGitHubActionsClient({ repository: "owner/name", workflow: "w" }), /GitHub token is required/u);
});

test("a failing audit sink stops the run rather than losing the record", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "atlas-audit-"));
  const sessions = new AgentSessionStore(join(directory, "agent.sqlite"));
  t.after(async () => { sessions.close(); await rm(directory, { recursive: true, force: true }); });
  const runtime = new AgentRuntime({
    sessions,
    executors: { local: completingExecutor() },
    audit: (category) => { if (category === "agent.assistant_message") throw new Error("audit disk is full"); },
  });
  t.after(async () => { await runtime.stop(); });

  const session = runtime.createSession({ title: "Audit", repository: "/tmp/x", model: "m" });
  runtime.submitTurn(session.id, { text: "Go." });
  await runtime.drain();

  const finished = runtime.getSession(session.id);
  assert.equal(finished.status, "failed");
  assert.match(finished.summary, /audit disk is full/u);
});

test("a reconnecting client is replayed the whole log, not one page of it", async (t) => {
  const { sessions, runtime } = await harness(t);
  const session = runtime.createSession({ title: "Long session", model: "local-model" });

  // More events than any one replay query reads. A real session reaches this:
  // every status line, tool proposal and tool result is an event.
  const written = 6_000;
  for (let index = 0; index < written; index += 1) {
    sessions.appendEvent(session.id, { kind: "status", data: { summary: `event ${index}` } });
  }
  const total = sessions.session(session.id).lastSequence;

  const seen = [];
  const unsubscribe = runtime.subscribe(session.id, 0, (event) => seen.push(event.sequence));
  t.after(() => unsubscribe());

  // Reading one bounded page and then going live left everything between the
  // page's end and the present undelivered — silently, with the client
  // believing it had caught up.
  assert.equal(seen.length, total, `${total - seen.length} events were never delivered`);
  assert.deepEqual(seen, Array.from({ length: total }, (unused, index) => index + 1), "delivered in order with no gap");

  // Resuming from a cursor past the first page works the same way.
  const resumed = [];
  const stop = runtime.subscribe(session.id, 5_500, (event) => resumed.push(event.sequence));
  t.after(() => stop());
  assert.equal(resumed[0], 5_501);
  assert.equal(resumed.at(-1), total);

  // The plain read is paged too, for the same reason.
  assert.equal(runtime.getEvents(session.id, 0).length, total);
});

test("a long wall-clock budget is not cancelled one millisecond in", async (t) => {
  const { executor, state } = controllableExecutor();
  const { runtime } = await harness(t, { executors: { local: executor } });

  // Node's setTimeout cannot hold a delay this long: past 2^31-1 ms it warns
  // and fires on the next tick instead. Armed in one call, the run was
  // cancelled immediately and told its time budget was spent.
  const session = runtime.createSession({
    title: "Patient session",
    model: "local-model",
    budget: { elapsedMs: 30 * 24 * 60 * 60 * 1000 },
  });

  runtime.submitTurn(session.id, { text: "Take your time." });
  await waitFor(() => state.release !== null);
  await new Promise((resolve) => setTimeout(resolve, 25));

  assert.equal(runtime.getSession(session.id).status, "running", "the run was cancelled by its own deadline timer");
  assert.equal(state.sawAbort, false, "the run was aborted despite having a month of budget left");

  state.release();
  await runtime.drain();
  assert.equal(runtime.getSession(session.id).status, "completed");
});

test("turns keep their submitted order even when they share a millisecond", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "atlas-turn-order-"));
  t.after(async () => { await rm(directory, { recursive: true, force: true }); });
  const sessions = new AgentSessionStore(join(directory, "agent.sqlite"));
  t.after(() => sessions.close());

  const session = sessions.createSession({ title: "Fast typist", model: "local-model" });

  // Ten turns with no delay between them, as a person sending several
  // messages in a row produces. Ordering by a millisecond timestamp and
  // breaking ties on a random UUID answered about a quarter of such pairs
  // backwards -- "deploy the staging build" answered after "actually, wait".
  const submitted = [];
  for (let index = 0; index < 10; index += 1) {
    submitted.push(sessions.addTurn({ sessionId: session.id, role: "user", text: `message ${index}` }).id);
  }

  assert.deepEqual(sessions.turns(session.id).map((turn) => turn.id), submitted);
  assert.equal(sessions.nextPendingTurn(session.id).text, "message 0", "the queue hands back the oldest turn");

  // The same order decides what an edit discards.
  const removed = sessions.deleteTurnsAfter(session.id, submitted[3]);
  assert.equal(removed, 6);
  assert.deepEqual(sessions.turns(session.id).map((turn) => turn.text), ["message 0", "message 1", "message 2", "message 3"]);
});

test("a database written before turn ordering existed is numbered on open", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "atlas-turn-migrate-"));
  t.after(async () => { await rm(directory, { recursive: true, force: true }); });
  const file = join(directory, "agent.sqlite");

  // The old schema, with no ordering column at all.
  const { DatabaseSync } = await import("node:sqlite");
  const legacy = new DatabaseSync(file);
  legacy.exec(`
    CREATE TABLE agent_sessions (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, repository TEXT, model TEXT NOT NULL,
      executor TEXT NOT NULL, status TEXT NOT NULL, summary TEXT, budget_json TEXT NOT NULL,
      usage_json TEXT NOT NULL, lease_owner TEXT, lease_expires_at TEXT,
      last_sequence INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE agent_turns (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, role TEXT NOT NULL, text TEXT NOT NULL,
      attachments_json TEXT NOT NULL DEFAULT '[]', state TEXT NOT NULL,
      created_at TEXT NOT NULL, started_at TEXT, completed_at TEXT
    );
    CREATE INDEX agent_turns_session_idx ON agent_turns(session_id, created_at);
    INSERT INTO agent_sessions VALUES ('s1','Old','r','m','local','idle',NULL,'{}','{}',NULL,NULL,0,'t','t');
    INSERT INTO agent_turns VALUES ('turn-c','s1','user','third','[]','completed','t',NULL,NULL);
    INSERT INTO agent_turns VALUES ('turn-a','s1','user','first','[]','completed','t',NULL,NULL);
    INSERT INTO agent_turns VALUES ('turn-b','s1','user','second','[]','pending','t',NULL,NULL);
  `);
  legacy.close();

  // Opening it adds the column and numbers the existing rows by the order
  // they were inserted, which is the order they were sent.
  const sessions = new AgentSessionStore(file);
  t.after(() => sessions.close());
  assert.deepEqual(sessions.turns("s1").map((turn) => turn.text), ["third", "first", "second"]);
  assert.deepEqual(sessions.turns("s1").map((turn) => turn.sequence), [1, 2, 3]);

  // And a turn added afterwards goes on the end rather than colliding.
  const added = sessions.addTurn({ sessionId: "s1", role: "user", text: "fourth" });
  assert.equal(added.sequence, 4);
  assert.deepEqual(sessions.turns("s1").map((turn) => turn.text), ["third", "first", "second", "fourth"]);
});

test("a turn blocked by another runtime's lease is picked up when it lapses", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "atlas-lease-"));
  t.after(async () => { await rm(directory, { recursive: true, force: true }); });
  const sessions = new AgentSessionStore(join(directory, "agent.sqlite"));
  t.after(() => sessions.close());

  const runtime = new AgentRuntime({
    sessions,
    executors: { local: completingExecutor() },
    instanceId: "runtime-A",
    leaseMs: 400,
  });
  t.after(async () => { await runtime.stop(); });

  const session = runtime.createSession({ title: "Contended", model: "local-model" });

  // A second runtime took the lease and then died without releasing it -- a
  // kill, a closed laptop, a container reaped mid-run.
  sessions.acquireLease(session.id, "runtime-B", new Date(Date.now() + 400).toISOString());

  runtime.submitTurn(session.id, { text: "please do the thing" });
  await runtime.drain();

  // Declining is right; declining and never coming back is not. The turn used
  // to sit here queued forever, with the operator told only that some other
  // runtime held the lease.
  assert.equal(runtime.getSession(session.id).status, "queued");
  assert.equal(sessions.turns(session.id)[0].state, "pending");
  assert.ok(
    runtime.getEvents(session.id).some((event) => /waiting for it to finish or lapse/u.test(event.data.summary ?? "")),
    "the operator is told what is being waited on",
  );

  await waitFor(() => runtime.getSession(session.id).status === "completed", 4_000);
  assert.equal(sessions.turns(session.id)[0].state, "completed");
  assert.equal(sessions.session(session.id).leaseOwner, null, "the lease was released after the takeover");
});
