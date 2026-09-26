import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { eq } from "drizzle-orm";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import { consumeApproval, decideApproval } from "../app/api/computer/approval-state.mjs";

// Same columns as computer_approvals in db/schema.ts.
const approvals = sqliteTable("computer_approvals", {
  id: text("id").primaryKey(),
  taskId: text("task_id").notNull(),
  requestedBy: text("requested_by").notNull(),
  actionHash: text("action_hash").notNull(),
  summary: text("summary").notNull(),
  status: text("status").notNull(),
  expiresAt: text("expires_at").notNull(),
  decidedAt: text("decided_at"),
  consumedAt: text("consumed_at"),
});

/** A real SQLite database behind drizzle, with an await between statements like D1. */
function database() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`CREATE TABLE computer_approvals (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, requested_by TEXT NOT NULL, action_hash TEXT NOT NULL, summary TEXT NOT NULL, status TEXT NOT NULL, expires_at TEXT NOT NULL, decided_at TEXT, consumed_at TEXT)`);
  const db = drizzle(async (sql, params, method) => {
    await new Promise((resolve) => setImmediate(resolve));
    const statement = sqlite.prepare(sql);
    statement.setReturnArrays?.(true);
    if (method === "run") { statement.run(...params); return { rows: [] }; }
    const rows = statement.all(...params).map((row) => (Array.isArray(row) ? row : Object.values(row)));
    return { rows: method === "get" ? rows[0] : rows };
  });
  return { db, sqlite };
}

const future = () => new Date(Date.now() + 5 * 60_000).toISOString();
const past = () => new Date(Date.now() - 1_000).toISOString();

function seed(sqlite, overrides = {}) {
  const row = { id: "a1", task_id: "t1", requested_by: "github:owner", action_hash: "h1", summary: "Submit", status: "approved", expires_at: future(), consumed_at: null, ...overrides };
  sqlite.prepare("INSERT INTO computer_approvals (id, task_id, requested_by, action_hash, summary, status, expires_at, consumed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(row.id, row.task_id, row.requested_by, row.action_hash, row.summary, row.status, row.expires_at, row.consumed_at);
}

test("concurrent consumers of one approval: exactly one succeeds", async () => {
  const { db, sqlite } = database();
  seed(sqlite);
  // Each consumer does what the route does: read (every read sees "approved"),
  // then attempt the conditional consume.
  const consumer = async () => {
    const [row] = await db.select().from(approvals).where(eq(approvals.id, "a1"));
    assert.equal(row.status === "approved" || row.status === "consumed", true);
    return consumeApproval(db, approvals, { id: "a1", actionHash: "h1" });
  };
  const results = await Promise.all(Array.from({ length: 12 }, consumer));
  assert.equal(results.filter(Boolean).length, 1, "one approval authorizes one action");
  const [row] = await db.select().from(approvals).where(eq(approvals.id, "a1"));
  assert.equal(row.status, "consumed");
  assert.ok(row.consumedAt);
});

test("expired, pending, rejected, mismatched or already-consumed approvals are not consumed", async () => {
  for (const [overrides, hash] of [
    [{ expires_at: past() }, "h1"],
    [{ status: "pending" }, "h1"],
    [{ status: "rejected" }, "h1"],
    [{ status: "approved", consumed_at: new Date().toISOString() }, "h1"],
    [{}, "other-hash"],
  ]) {
    const { db, sqlite } = database();
    seed(sqlite, overrides);
    assert.equal(await consumeApproval(db, approvals, { id: "a1", actionHash: hash }), null, JSON.stringify(overrides));
  }
});

test("an owner can decide a pending approval once, and not after it expires", async () => {
  const { db, sqlite } = database();
  seed(sqlite, { status: "pending" });
  seed(sqlite, { id: "a2", status: "pending", expires_at: past() });
  const decisions = await Promise.all([
    decideApproval(db, approvals, { id: "a1", owner: "github:owner", decision: "approved" }),
    decideApproval(db, approvals, { id: "a1", owner: "github:owner", decision: "rejected" }),
  ]);
  assert.equal(decisions.filter((rows) => rows.length === 1).length, 1);
  assert.equal((await decideApproval(db, approvals, { id: "a1", owner: "github:intruder", decision: "approved" })).length, 0);
  assert.equal((await decideApproval(db, approvals, { id: "a2", owner: "github:owner", decision: "approved" })).length, 0, "expired approvals cannot be granted");
});

test("the routes authorize on the conditional update, not on the earlier read", () => {
  const consume = readFileSync(new URL("../app/api/computer/companion/approval/[id]/route.ts", import.meta.url), "utf8");
  assert.match(consume, /const consumed = await consumeApproval\(/u);
  assert.match(consume, /if \(!consumed\) return Response\.json\(\{ status: "already-consumed" \}, \{ status: 409 \}\)/u);
  assert.doesNotMatch(consume, /db\.update\(/u);
  const decide = readFileSync(new URL("../app/api/computer/approvals/[id]/route.ts", import.meta.url), "utf8");
  assert.match(decide, /decideApproval\(/u);
});
