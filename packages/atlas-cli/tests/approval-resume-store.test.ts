import assert from "node:assert/strict";
import test from "node:test";
import {
  ApprovalResumeCapacityError,
  InMemoryApprovalResumeStore,
} from "../src/infrastructure/in-memory-approval-resume-store.js";

const base = {
  sessionId: "session-1",
  repositoryId: "repository-1",
  toolId: "repository.read",
  toolCallId: "call-1",
  arguments: { path: "src/index.ts", startLine: 1 },
} as const;

test("issues opaque random tokens that contain no pending call data", () => {
  const store = new InMemoryApprovalResumeStore({ clock: () => 100 });
  const first = store.issue(base);
  const second = store.issue({ ...base, toolCallId: "call-2" });

  assert.notEqual(first.token, second.token);
  assert.match(first.token, /^[A-Za-z0-9_-]{43}$/);
  for (const secret of [base.sessionId, base.repositoryId, base.toolId, base.toolCallId, "index"]) {
    assert.equal(first.token.includes(secret), false);
  }
});

test("consumes approved, rejected, and cancelled calls exactly once", () => {
  for (const decision of ["approved", "rejected", "cancelled"] as const) {
    const store = new InMemoryApprovalResumeStore({ clock: () => 100 });
    const issued = store.issue(base);
    const result = store.consume(issued.token, base, decision);
    assert.equal(result.status, decision);
    assert.equal(store.consume(issued.token, base, decision).status, "unknown");
  }
});

test("does not consume a token on cross-session or repository binding mismatch", () => {
  const store = new InMemoryApprovalResumeStore({ clock: () => 100 });
  const issued = store.issue(base);

  assert.equal(store.consume(issued.token, { ...base, sessionId: "session-2" }, "approved").status, "binding-mismatch");
  assert.equal(store.consume(issued.token, { ...base, repositoryId: "repository-2" }, "approved").status, "binding-mismatch");
  assert.equal(store.consume(issued.token, base, "approved").status, "approved");
});

test("binds tokens to tool and call identifiers", () => {
  const store = new InMemoryApprovalResumeStore({ clock: () => 100 });
  const issued = store.issue(base);

  assert.equal(store.consume(issued.token, { ...base, toolId: "repository.search" }, "approved").status, "binding-mismatch");
  assert.equal(store.consume(issued.token, { ...base, toolCallId: "call-2" }, "approved").status, "binding-mismatch");
  assert.equal(store.consume(issued.token, base, "approved").status, "approved");
});

test("reports expiry and removes expired pending state", () => {
  let now = 1_000;
  const store = new InMemoryApprovalResumeStore({ clock: () => now, ttlMs: 50 });
  const issued = store.issue(base);
  now = 1_050;

  assert.equal(store.consume(issued.token, base, "approved").status, "expired");
  assert.equal(store.consume(issued.token, base, "approved").status, "unknown");
  assert.equal(store.size, 0);
});

test("fails explicitly at capacity and reclaims expired entries", () => {
  let now = 10;
  const store = new InMemoryApprovalResumeStore({ clock: () => now, ttlMs: 10, capacity: 1 });
  store.issue(base);
  assert.throws(() => store.issue({ ...base, toolCallId: "call-2" }), ApprovalResumeCapacityError);

  now = 20;
  assert.doesNotThrow(() => store.issue({ ...base, toolCallId: "call-2" }));
  assert.equal(store.size, 1);
});

test("returns deeply immutable snapshots isolated from caller mutation", () => {
  const mutable = { path: "src/index.ts", range: { start: 1 } };
  const store = new InMemoryApprovalResumeStore({ clock: () => 100 });
  const issued = store.issue({ ...base, arguments: mutable });
  mutable.path = "secret.txt";
  mutable.range.start = 99;

  assert.ok(Object.isFrozen(issued));
  assert.ok(Object.isFrozen(issued.pending));
  assert.ok(Object.isFrozen(issued.pending.arguments));
  const result = store.consume(issued.token, base, "approved");
  assert.equal(result.status, "approved");
  if (result.status === "approved") {
    assert.deepEqual(result.pending.arguments, { path: "src/index.ts", range: { start: 1 } });
    assert.ok(Object.isFrozen((result.pending.arguments as { range: object }).range));
  }
});

test("rejects unsafe configuration and identifiers", () => {
  assert.throws(() => new InMemoryApprovalResumeStore({ ttlMs: 0 }), RangeError);
  assert.throws(() => new InMemoryApprovalResumeStore({ capacity: 1.5 }), RangeError);
  const store = new InMemoryApprovalResumeStore();
  assert.throws(() => store.issue({ ...base, sessionId: "" }), TypeError);
});
