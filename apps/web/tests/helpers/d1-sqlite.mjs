// Test-only: an in-memory SQLite database with every Drizzle migration applied,
// exposed through the subset of the Cloudflare D1 binding API the app uses
// (prepare/bind/first/all/run/batch), so D1-backed modules run unmodified.
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";

const drizzleDirectory = new URL("../../drizzle/", import.meta.url);

export function migrationTags(until = Infinity) {
  const journal = JSON.parse(fs.readFileSync(new URL("meta/_journal.json", drizzleDirectory), "utf8"));
  return journal.entries.filter((entry) => entry.idx <= until).sort((left, right) => left.idx - right.idx).map((entry) => entry.tag);
}

export function applyMigrations(db, { until = Infinity, from = 0 } = {}) {
  const journal = JSON.parse(fs.readFileSync(new URL("meta/_journal.json", drizzleDirectory), "utf8"));
  for (const entry of journal.entries.sort((left, right) => left.idx - right.idx)) {
    if (entry.idx < from || entry.idx > until) continue;
    db.exec(fs.readFileSync(new URL(`${entry.tag}.sql`, drizzleDirectory), "utf8"));
  }
}

function plain(row) {
  return row ? { ...row } : null;
}

export function d1FromSqlite(db) {
  const statement = (sql, params = []) => ({
    bind: (...values) => statement(sql, values.map((value) => (value === undefined ? null : value))),
    first: async (column) => {
      const row = plain(db.prepare(sql).get(...params));
      if (column) return row ? row[column] ?? null : null;
      return row;
    },
    all: async () => ({ success: true, results: db.prepare(sql).all(...params).map(plain) }),
    run: async () => {
      const result = db.prepare(sql).run(...params);
      return { success: true, meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } };
    },
  });
  return {
    prepare: (sql) => statement(sql),
    batch: async (statements) => {
      db.exec("BEGIN");
      try {
        const results = [];
        for (const item of statements) results.push(await item.run());
        db.exec("COMMIT");
        return results;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
}

/** A fresh, fully migrated database plus its D1-shaped handle. */
export function migratedDatabase({ users = [] } = {}) {
  const sqlite = new DatabaseSync(":memory:");
  applyMigrations(sqlite);
  for (const [id, login] of users) {
    sqlite.prepare("INSERT INTO users (id, github_user_id, github_login) VALUES (?, ?, ?)").run(id, 100_000 + id, login);
  }
  return { sqlite, d1: d1FromSqlite(sqlite) };
}
