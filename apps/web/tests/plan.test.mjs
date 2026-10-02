import assert from "node:assert/strict";
import test from "node:test";
import { currentPeriodStart } from "../app/api/billing/period.mjs";

test("formats a period start with a zero-padded month", () => {
  assert.equal(currentPeriodStart(new Date(Date.UTC(2026, 8, 15))), "2026-09-01");
  assert.equal(currentPeriodStart(new Date(Date.UTC(2026, 0, 1))), "2026-01-01");
  assert.equal(currentPeriodStart(new Date(Date.UTC(2026, 11, 31))), "2026-12-01");
});

// checkAndRecordUsage imports the TypeScript schema, so resolve extensionless
// imports to .ts for this test (Node strips the types itself).
const { registerHooks } = await import("node:module");
registerHooks({
  resolve(specifier, context, nextResolve) {
    try { return nextResolve(specifier, context); } catch (error) {
      if (specifier.startsWith(".") && !/\.\w+$/u.test(specifier)) return nextResolve(`${specifier}.ts`, context);
      throw error;
    }
  },
});
const { drizzle } = await import("drizzle-orm/d1");
const { checkAndRecordUsage } = await import("../app/api/billing/plan.mjs");
const { migratedDatabase } = await import("./helpers/d1-sqlite.mjs");

const NOW = new Date(Date.UTC(2026, 9, 2));

test("concurrent task requests are each counted and never exceed the plan cap", async () => {
  const { sqlite, d1 } = migratedDatabase({ users: [[1, "alice"]] });
  try {
    const db = drizzle(d1);
    const results = await Promise.all(Array.from({ length: 30 }, () => checkAndRecordUsage(db, 1, "inspect", NOW)));
    assert.equal(results.filter((result) => result.allowed).length, 20);
    assert.equal(sqlite.prepare("SELECT task_count FROM task_usage WHERE user_id = 1").get().task_count, 20);
    const denied = await checkAndRecordUsage(db, 1, "inspect", NOW);
    assert.equal(denied.allowed, false);
    assert.match(denied.reason, /Monthly task limit reached \(20 for the free plan\)/u);
    // A new month starts a fresh count.
    assert.equal((await checkAndRecordUsage(db, 1, "inspect", new Date(Date.UTC(2026, 10, 1)))).used, 1);
  } finally { sqlite.close(); }
});

test("a mode outside the plan is refused without recording usage", async () => {
  const { sqlite, d1 } = migratedDatabase({ users: [[1, "alice"]] });
  try {
    const result = await checkAndRecordUsage(drizzle(d1), 1, "coder", NOW);
    assert.equal(result.allowed, false);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM task_usage").get().n, 0);
  } finally { sqlite.close(); }
});
