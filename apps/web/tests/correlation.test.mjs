import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { CORRELATION_HEADER, acceptCorrelationId, correlationIdFromRequest, isCorrelationId, newCorrelationId } from "../app/api/tasks/correlation.mjs";

const pattern = /^cor_[0-9a-f]{32}$/;

test("generates unique ids in the shared contract format", () => {
  const ids = new Set(Array.from({ length: 50 }, () => newCorrelationId()));
  assert.equal(ids.size, 50);
  for (const id of ids) { assert.match(id, pattern); assert.equal(isCorrelationId(id), true); }
});

test("validation accepts only cor_ + 32 lowercase hex", () => {
  for (const bad of [undefined, null, 42, "", "cor_", "cor_123", `COR_${"a".repeat(32)}`, `cor_${"A".repeat(32)}`, `cor_${"a".repeat(33)}`, `tsk_${"a".repeat(32)}`, `cor_${"a".repeat(32)}\nx`]) {
    assert.equal(isCorrelationId(bad), false, String(bad));
  }
});

test("a well-formed incoming header is honoured; a forged one is replaced", () => {
  const good = `cor_${"ab".repeat(16)}`;
  assert.equal(correlationIdFromRequest(new Request("https://atlas.test/api/tasks", { headers: { [CORRELATION_HEADER]: good } })), good);
  const forged = correlationIdFromRequest(new Request("https://atlas.test/api/tasks", { headers: { [CORRELATION_HEADER]: "cor_evil\" injected=1" } }));
  assert.match(forged, pattern);
  assert.notEqual(forged, "cor_evil\" injected=1");
  assert.match(correlationIdFromRequest(new Request("https://atlas.test/api/tasks")), pattern);
  assert.match(correlationIdFromRequest(null), pattern);
  assert.equal(acceptCorrelationId(good), good);
  assert.notEqual(acceptCorrelationId(`${good}0`), `${good}0`);
});

test("migration 0013 adds a nullable correlation_id to existing task rows", () => {
  const sql = fs.readFileSync(new URL("../drizzle/0013_task_correlation_id.sql", import.meta.url), "utf8");
  const journal = JSON.parse(fs.readFileSync(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8"));
  const entry = journal.entries.find((item) => item.tag === "0013_task_correlation_id");
  assert.equal(entry?.idx, 13);
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("CREATE TABLE tasks (id integer PRIMARY KEY AUTOINCREMENT NOT NULL, task_id text NOT NULL, objective text NOT NULL)");
    db.prepare("INSERT INTO tasks (task_id, objective) VALUES (?, ?)").run("old", "pre-existing");
    db.exec(sql);
    assert.equal(db.prepare("SELECT correlation_id FROM tasks WHERE task_id = 'old'").get().correlation_id, null);
    const id = `cor_${"cd".repeat(16)}`;
    db.prepare("INSERT INTO tasks (task_id, objective, correlation_id) VALUES (?, ?, ?)").run("new", "x", id);
    assert.equal(db.prepare("SELECT task_id FROM tasks WHERE correlation_id = ?").get(id).task_id, "new");
  } finally { db.close(); }
});
