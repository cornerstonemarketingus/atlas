import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

test("automation migration creates records, run history, and dedupe uniqueness", () => {
  const sql = fs.readFileSync(new URL("../drizzle/0015_automations.sql", import.meta.url), "utf8");
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(`
      CREATE TABLE users (id integer PRIMARY KEY, github_user_id integer, github_login text, created_at text);
      ${sql}
    `);
    db.prepare("INSERT INTO automations (id, requested_by, name, repository, branch, mode, objective, trigger_type, trigger_config) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run("auto-1", "github:test", "Weekly", "cornerstonemarketingus/atlas", "main", "debug", "Update deps", "cron", '{"cron":"0 9 * * 1"}');
    db.prepare("INSERT INTO automation_runs (id, automation_id, requested_by, status, dedupe_key) VALUES (?, ?, ?, ?, ?)")
      .run("run-1", "auto-1", "github:test", "started", "cron:2026-09-28T09:00:00.000Z");
    assert.throws(
      () => db.prepare("INSERT INTO automation_runs (id, automation_id, requested_by, status, dedupe_key) VALUES (?, ?, ?, ?, ?)").run("run-2", "auto-1", "github:test", "started", "cron:2026-09-28T09:00:00.000Z"),
      /UNIQUE/u,
    );
  } finally {
    db.close();
  }
});
