import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";

test("repository policy recovery repairs missing baseline tables and preserves existing policy", () => {
  const sql = fs.readFileSync(new URL("../drizzle/0012_repository_policy_recovery.sql", import.meta.url), "utf8");
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(sql);
    db.prepare("INSERT INTO repositories (owner, name, merge_policy) VALUES (?, ?, ?)").run("owner", "repo", "ci-gated");
    db.exec(sql);
    const rows = db.prepare("SELECT id, installation_id, owner, name, merge_policy, created_at, updated_at FROM repositories").all();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].merge_policy, "ci-gated");
    assert.throws(() => db.prepare("INSERT INTO repositories (owner,name) VALUES ('owner','repo')").run(), /UNIQUE/);
  } finally { db.close(); }
});
