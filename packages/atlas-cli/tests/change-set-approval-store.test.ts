import assert from "node:assert/strict";
import test from "node:test";
import { ChangeSetApprovalCapacityError, InMemoryChangeSetApprovalStore } from "../src/infrastructure/in-memory-change-set-approval-store.js";

const digest = "a".repeat(64);
const request = { sessionId: "session-1", repositoryId: "repository-1", changeSetDigest: digest } as const;

test("issues opaque tokens and metadata-only records", () => {
  const store = new InMemoryChangeSetApprovalStore({ clock: () => 100 });
  const issued = store.issue(request);
  assert.match(issued.token, /^[A-Za-z0-9_-]{43}$/);
  for (const value of Object.values(request)) assert.equal(issued.token.includes(value), false);
  const [record] = store.snapshot();
  assert.ok(record);
  assert.deepEqual(Object.keys(record).sort(), ["approvalId", "changeSetDigest", "createdAtMs", "expiresAtMs", "repositoryId", "sessionId", "state", "tokenHash"]);
  assert.equal(JSON.stringify(record).includes(issued.token), false);
  assert.ok(Object.isFrozen(record));
});

test("consumes a bound approval exactly once and retains replay evidence", () => {
  const store = new InMemoryChangeSetApprovalStore({ clock: () => 100 });
  const issued = store.issue(request);
  const accepted = store.consume(issued.token, request, "approved");
  assert.equal(accepted.status, "approved");
  assert.equal(store.consume(issued.token, request, "approved").status, "replayed");
  const [record] = store.snapshot();
  assert.equal(record?.state, "approved");
  assert.equal(record?.decidedAtMs, 100);
});

test("enforces all change-set bindings without consuming a mismatched token", () => {
  const store = new InMemoryChangeSetApprovalStore({ clock: () => 100 });
  const issued = store.issue(request);
  assert.equal(store.consume(issued.token, { ...request, sessionId: "other" }, "approved").status, "binding-mismatch");
  assert.equal(store.consume(issued.token, { ...request, repositoryId: "other" }, "approved").status, "binding-mismatch");
  assert.equal(store.consume(issued.token, { ...request, changeSetDigest: "b".repeat(64) }, "approved").status, "binding-mismatch");
  assert.equal(store.consume(issued.token, request, "rejected").status, "rejected");
});

test("expires records, enforces capacity, and restores metadata snapshots", () => {
  let now = 100;
  const store = new InMemoryChangeSetApprovalStore({ clock: () => now, ttlMs: 20, capacity: 1 });
  const issued = store.issue(request);
  assert.throws(() => store.issue({ ...request, sessionId: "other" }), ChangeSetApprovalCapacityError);
  const restored = new InMemoryChangeSetApprovalStore({ clock: () => now, records: store.snapshot() });
  assert.equal(restored.consume(issued.token, request, "approved").status, "approved");
  now = 120;
  assert.equal(store.consume(issued.token, request, "approved").status, "expired");
  assert.equal(store.size, 0);
});

test("rejects unsafe digests and persisted records", () => {
  const store = new InMemoryChangeSetApprovalStore();
  assert.throws(() => store.issue({ ...request, changeSetDigest: "not-a-digest" }), TypeError);
  assert.throws(() => new InMemoryChangeSetApprovalStore({ records: [{ ...request, approvalId: "id", tokenHash: digest, state: "pending", createdAtMs: 10, expiresAtMs: 9 }] }), TypeError);
});
