import assert from "node:assert/strict";
import test from "node:test";
import {
  InMemorySessionAuditLog,
  SessionAuditOverflowError,
} from "../src/infrastructure/in-memory-session-audit-log.js";

test("records versioned events with monotonic sequences and immutable snapshots", () => {
  const times = [new Date("2026-08-03T12:00:00.000Z"), new Date("2026-08-03T12:00:01.000Z")];
  let index = 0;
  const log = new InMemorySessionAuditLog({
    clock: () => times[index++] ?? new Date("2026-08-03T12:00:02.000Z"),
  });

  const started = log.append("session.started", {
    sessionId: "session-1",
    repositoryId: "sha256:repository",
  });
  const completed = log.append("session.completed", {
    sessionId: "session-1",
    summary: "Plan produced.",
  });

  assert.equal(started.schemaVersion, 1);
  assert.equal(started.sequence, 1);
  assert.equal(started.occurredAt, "2026-08-03T12:00:00.000Z");
  assert.equal(completed.sequence, 2);
  const snapshot = log.snapshot();
  assert.deepEqual(snapshot, [started, completed]);
  assert.ok(Object.isFrozen(snapshot));
  assert.ok(Object.isFrozen(started));
  assert.ok(Object.isFrozen(started.payload));
  assert.throws(() => (snapshot as SessionEventMutation[]).push(started));
});

test("clones payloads so later caller mutation cannot alter audit history", () => {
  const log = new InMemorySessionAuditLog();
  const payload = {
    code: "MODEL_TIMEOUT",
    summary: "Provider timed out.",
    recoverable: true,
  };
  const event = log.append("error.recorded", payload);
  payload.summary = "secret replacement";

  assert.equal(event.payload.summary, "Provider timed out.");
});

test("captures model, tool, policy, budget, approval, blocker, and error metadata", () => {
  const log = new InMemorySessionAuditLog();
  log.append("model.requested", { requestId: "r1", providerId: "mock", modelId: "test", messageCount: 2, inputCharacters: 20, toolsOffered: 1 });
  log.append("model.responded", { requestId: "r1", finishReason: "tool_calls", inputTokens: 8, outputTokens: 3, outputCharacters: 10, toolCallCount: 1 });
  log.append("tool.requested", { requestId: "r1", toolCallId: "tc1", toolId: "repository.search", argumentCount: 2 });
  log.append("tool.policy_decided", { toolCallId: "tc1", decision: "ask", reason: "User approval required." });
  log.append("approval.recorded", { approvalId: "a1", toolCallId: "tc1", decision: "approved", actorId: "user-1" });
  log.append("tool.completed", { toolCallId: "tc1", outcome: "succeeded", durationMs: 5, resultCharacters: 42 });
  log.append("budget.updated", { inputTokens: 8, outputTokens: 3, toolCalls: 1, elapsedMs: 9, costMicrounits: 0 });
  log.append("session.blocked", { sessionId: "s1", summary: "No eligible provider." });
  log.append("error.recorded", { code: "NO_PROVIDER", summary: "No eligible provider.", recoverable: true });

  assert.equal(log.size, 9);
  assert.deepEqual(log.snapshot().map((event) => event.type), [
    "model.requested", "model.responded", "tool.requested", "tool.policy_decided",
    "approval.recorded", "tool.completed", "budget.updated", "session.blocked", "error.recorded",
  ]);
});

test("fails explicitly without evicting events when capacity is exhausted", () => {
  const log = new InMemorySessionAuditLog({ maxEvents: 1 });
  log.append("session.started", { sessionId: "s1" });

  assert.throws(
    () => log.append("session.failed", { sessionId: "s1", summary: "Stopped." }),
    (error: unknown) => error instanceof SessionAuditOverflowError
      && error.code === "SESSION_AUDIT_CAPACITY_EXCEEDED"
      && error.capacity === 1,
  );
  assert.equal(log.size, 1);
  assert.equal(log.snapshot()[0]?.sequence, 1);
});

test("rejects invalid capacities", () => {
  for (const maxEvents of [0, -1, 1.5, Number.POSITIVE_INFINITY]) {
    assert.throws(() => new InMemorySessionAuditLog({ maxEvents }), RangeError);
  }
});

type SessionEventMutation = { sequence: number };
