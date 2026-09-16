import assert from "node:assert/strict";
import test from "node:test";

import { reconstructSessions } from "../src/agent/session-replay.js";
import { renderReplayText } from "../src/presentation/replay-renderers.js";
import { executeReplayCommand } from "../src/cli-replay.js";
import { main } from "../src/cli.js";
import type { SessionEvent, SessionEventType } from "../src/domain/session-audit.js";

let sequence = 0;
function event(type: SessionEventType, payload: Record<string, unknown>, secondsIn = sequence): SessionEvent {
  sequence += 1;
  return {
    schemaVersion: 1,
    sequence,
    occurredAt: new Date(Date.parse("2026-09-16T10:00:00.000Z") + secondsIn * 1_000).toISOString(),
    type,
    payload,
  } as SessionEvent;
}

function completeSession(): SessionEvent[] {
  sequence = 0;
  return [
    event("session.started", { sessionId: "s1", repositoryId: "atlas" }, 0),
    event("model.requested", { requestId: "r1", providerId: "groq", modelId: "gpt-oss-120b", messageCount: 2, inputCharacters: 4000, toolsOffered: 7 }, 1),
    event("model.responded", { requestId: "r1", finishReason: "tool-calls", inputTokens: 1200, outputTokens: 80, outputCharacters: 300, toolCallCount: 1 }, 2),
    event("tool.requested", { requestId: "r1", toolCallId: "c1", toolId: "repository.search", argumentCount: 2 }, 3),
    event("tool.policy_decided", { toolCallId: "c1", decision: "allow", reason: "read allowed" }, 3),
    event("tool.completed", { toolCallId: "c1", outcome: "succeeded", durationMs: 120, resultCharacters: 900 }, 4),
    event("session.completed", { sessionId: "s1", summary: "proposed 1 change" }, 9),
  ];
}

test("reconstructs a session's turns and tool calls in order", () => {
  const [session] = reconstructSessions(completeSession());
  assert.equal(session?.sessionId, "s1");
  assert.equal(session?.outcome, "completed");
  assert.equal(session?.repositoryId, "atlas");
  assert.equal(session?.durationMs, 9_000);
  assert.equal(session?.turns.length, 1);
  assert.equal(session?.turns[0]?.toolCalls[0]?.toolId, "repository.search");
  assert.equal(session?.turns[0]?.toolCalls[0]?.outcome, "succeeded");
  assert.deepEqual(session?.totals, {
    turns: 1,
    toolCalls: 1,
    unfinishedToolCalls: 0,
    inputTokens: 1_200,
    outputTokens: 80,
  });
});

test("keeps a turn that never got a response, rather than dropping it", () => {
  // A trace that stops mid-turn is the one worth reading. Discarding the
  // incomplete turn to keep the model tidy would throw away the reason
  // someone opened the file.
  sequence = 0;
  const [session] = reconstructSessions([
    event("session.started", { sessionId: "s1" }, 0),
    event("model.requested", { requestId: "r1", providerId: "groq", modelId: "m", messageCount: 1, inputCharacters: 10, toolsOffered: 1 }, 1),
  ]);
  assert.equal(session?.outcome, "unfinished");
  assert.equal(session?.turns.length, 1);
  assert.equal(session?.turns[0]?.unfinished, true);
});

test("keeps a tool call that never returned, and counts it", () => {
  // "Called repository.search and never got a result" is the single most
  // diagnostic fact a truncated trace contains.
  sequence = 0;
  const [session] = reconstructSessions([
    event("session.started", { sessionId: "s1" }, 0),
    event("model.requested", { requestId: "r1", providerId: "g", modelId: "m", messageCount: 1, inputCharacters: 1, toolsOffered: 1 }, 1),
    event("model.responded", { requestId: "r1", finishReason: "tool-calls", inputTokens: 1, outputTokens: 1, outputCharacters: 1, toolCallCount: 1 }, 2),
    event("tool.requested", { requestId: "r1", toolCallId: "c1", toolId: "repository.search", argumentCount: 1 }, 3),
  ]);
  assert.equal(session?.turns[0]?.toolCalls[0]?.unfinished, true);
  assert.equal(session?.totals.unfinishedToolCalls, 1);
  assert.match(renderReplayText([session!]), /repository\.search — NO RESULT/u);
});

test("separates two sessions in one append-only file", () => {
  // The store appends, so repeated flushes into one file are normal. Folding
  // them together would attribute one session's failure to another.
  sequence = 0;
  const events = [
    ...completeSession(),
    event("session.started", { sessionId: "s2" }, 20),
    event("session.failed", { sessionId: "s2", summary: "413 too large" }, 21),
  ];
  const sessions = reconstructSessions(events);
  assert.equal(sessions.length, 2);
  assert.equal(sessions[1]?.sessionId, "s2");
  assert.equal(sessions[1]?.outcome, "failed");
  assert.equal(sessions[1]?.summary, "413 too large");
});

test("reconstructs a trace whose opening event was lost", () => {
  sequence = 0;
  const [session] = reconstructSessions([
    event("model.requested", { requestId: "r1", providerId: "g", modelId: "m", messageCount: 1, inputCharacters: 1, toolsOffered: 0 }, 1),
    event("session.failed", { sessionId: "s9", summary: "died" }, 2),
  ]);
  assert.equal(session?.turns.length, 1);
  assert.equal(session?.outcome, "failed");
});

test("orders by sequence, not by arrival", () => {
  const shuffled = [...completeSession()].reverse();
  const [session] = reconstructSessions(shuffled);
  assert.equal(session?.sessionId, "s1", "the started event must still open the session");
  assert.equal(session?.turns.length, 1);
  assert.equal(session?.turns[0]?.toolCalls.length, 1);
});

test("surfaces a policy denial with its reason", () => {
  sequence = 0;
  const [session] = reconstructSessions([
    event("session.started", { sessionId: "s1" }, 0),
    event("model.requested", { requestId: "r1", providerId: "g", modelId: "m", messageCount: 1, inputCharacters: 1, toolsOffered: 1 }, 1),
    event("tool.requested", { requestId: "r1", toolCallId: "c1", toolId: "repository.delete", argumentCount: 0 }, 2),
    event("tool.policy_decided", { toolCallId: "c1", decision: "deny", reason: "write not allowed" }, 2),
  ]);
  assert.match(renderReplayText([session!]), /policy: deny — write not allowed/u);
});

test("records errors with their recoverability", () => {
  sequence = 0;
  const [session] = reconstructSessions([
    event("session.started", { sessionId: "s1" }, 0),
    event("error.recorded", { code: "TOOL_NOT_FOUND", summary: "no tool named repo.search", recoverable: true }, 1),
  ]);
  assert.equal(session?.errors[0]?.code, "TOOL_NOT_FOUND");
  assert.equal(session?.errors[0]?.recoverable, true);
  assert.match(renderReplayText([session!]), /TOOL_NOT_FOUND \(recoverable\)/u);
});

test("puts the verdict first, because that is what a reader came for", () => {
  const [session] = reconstructSessions(completeSession());
  const first = renderReplayText([session!]).split("\n")[0] ?? "";
  assert.match(first, /^Session s1 — completed$/u);
});

test("says so plainly rather than rendering an empty report", () => {
  assert.match(renderReplayText([]), /No sessions found/u);
});

// --- command -------------------------------------------------------------

function harness(trace: string) {
  const out: string[] = [];
  const err: string[] = [];
  return {
    stdout: () => out.join(""),
    stderr: () => err.join(""),
    dependencies: {
      readTrace: async () => trace,
      write: (text: string) => out.push(text),
      writeError: (text: string) => err.push(text),
    },
  };
}

const TRACE = completeSession().map((item) => JSON.stringify(item)).join("\n");

test("reads a trace file and renders it", async () => {
  const harnessed = harness(TRACE);
  assert.equal(await executeReplayCommand(["replay", "audit.jsonl"], harnessed.dependencies), 0);
  assert.match(harnessed.stdout(), /Session s1 — completed/u);
  assert.match(harnessed.stdout(), /repository\.search/u);
});

test("reconstructs everything legible when the last line is truncated", async () => {
  // A run killed mid-write leaves a half-written line. Refusing the whole
  // file over that withholds the record exactly when it is wanted.
  const harnessed = harness(`${TRACE}\n{"schemaVersion":1,"sequence":99,"typ`);
  assert.equal(await executeReplayCommand(["replay", "audit.jsonl"], harnessed.dependencies), 0);
  assert.match(harnessed.stdout(), /Session s1 — completed/u);
  assert.match(harnessed.stderr(), /1 unreadable line\(s\) skipped/u);
});

test("filters to one session and reports an id that is not there", async () => {
  const two = `${TRACE}\n${JSON.stringify({ schemaVersion: 1, sequence: 50, occurredAt: "2026-09-16T10:01:00.000Z", type: "session.started", payload: { sessionId: "s2" } })}`;
  const kept = harness(two);
  assert.equal(await executeReplayCommand(["replay", "a.jsonl", "--session", "s2"], kept.dependencies), 0);
  assert.equal(kept.stdout().includes("Session s1"), false);

  const missing = harness(two);
  assert.equal(await executeReplayCommand(["replay", "a.jsonl", "--session", "nope"], missing.dependencies), 1);
  assert.match(missing.stderr(), /No session 'nope'/u);
});

test("emits machine-readable output on request", async () => {
  const harnessed = harness(TRACE);
  assert.equal(await executeReplayCommand(["replay", "a.jsonl", "--format", "json"], harnessed.dependencies), 0);
  const parsed = JSON.parse(harnessed.stdout()) as { sessions: { sessionId: string }[] };
  assert.equal(parsed.sessions[0]?.sessionId, "s1");
});

test("rejects bad arguments instead of guessing", async () => {
  const noPath = harness(TRACE);
  assert.equal(await executeReplayCommand(["replay"], noPath.dependencies), 2);
  assert.match(noPath.stderr(), /Usage: atlas replay/u);

  const badFormat = harness(TRACE);
  assert.equal(await executeReplayCommand(["replay", "a.jsonl", "--format", "yaml"], badFormat.dependencies), 2);

  const noSessionId = harness(TRACE);
  assert.equal(await executeReplayCommand(["replay", "a.jsonl", "--session", "--format"], noSessionId.dependencies), 2);
});

test("reports an unreadable file rather than throwing", async () => {
  const err: string[] = [];
  const code = await executeReplayCommand(["replay", "missing.jsonl"], {
    readTrace: async () => { throw new Error("ENOENT: no such file"); },
    write: () => {},
    writeError: (text: string) => err.push(text),
  });
  assert.equal(code, 1);
  assert.match(err.join(""), /Could not read missing\.jsonl: ENOENT/u);
});

test("main() actually dispatches to replay", async () => {
  // Wiring, exercised through main() rather than the command. An unwired
  // subcommand falls through to the usage branch and exits 2; a wired one
  // reaches the reader and reports the missing file with exit 1. Three
  // features in this repository have shipped complete and unreachable.
  const errors: string[] = [];
  const original = console.error;
  console.error = (...parts: unknown[]) => { errors.push(parts.join(" ")); };
  const written: string[] = [];
  const originalWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((text: string) => { written.push(String(text)); return true; }) as typeof process.stderr.write;
  try {
    const code = await main(["replay", "/nonexistent/trace.jsonl"]);
    assert.equal(code, 1, "an unwired subcommand would fall through to usage and exit 2");
    assert.match(written.join(""), /Could not read \/nonexistent\/trace\.jsonl/u);
  } finally {
    console.error = original;
    process.stderr.write = originalWrite;
  }
});
