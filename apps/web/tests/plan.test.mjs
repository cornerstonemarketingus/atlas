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

const { checkAndRecordChatUsage } = await import("../app/api/billing/plan.mjs");
const { currentChatDayKey, nextChatReset } = await import("../app/api/billing/period.mjs");

test("chat day key and reset are UTC", () => {
  const late = new Date(Date.UTC(2026, 9, 31, 23, 59, 59));
  assert.equal(currentChatDayKey(late), "chat:2026-10-31");
  assert.equal(nextChatReset(late), "2026-11-01T00:00:00.000Z");
});

test("concurrent chat messages never exceed the free daily cap, and the next day starts fresh", async () => {
  const { sqlite, d1 } = migratedDatabase({ users: [[1, "alice"], [2, "bob"]] });
  try {
    const db = drizzle(d1);
    const results = await Promise.all(Array.from({ length: 40 }, () => checkAndRecordChatUsage(db, 1, NOW)));
    assert.equal(results.filter((r) => r.allowed).length, 20);
    assert.equal(sqlite.prepare("SELECT task_count FROM task_usage WHERE user_id = 1 AND period_start = 'chat:2026-10-02'").get().task_count, 20);
    const denied = await checkAndRecordChatUsage(db, 1, NOW);
    assert.equal(denied.allowed, false);
    assert.equal(denied.code, "CHAT_CAP_REACHED");
    assert.equal(denied.resetsAt, "2026-10-03T00:00:00.000Z");
    assert.match(denied.reason, /20 free messages.*\/pricing/u);
    assert.equal((await checkAndRecordChatUsage(db, 2, NOW)).used, 1, "another user is unaffected");
    assert.equal((await checkAndRecordChatUsage(db, 1, new Date(Date.UTC(2026, 9, 3)))).used, 1, "a new UTC day resets the cap");
    // Chat messages do not consume the monthly task allowance, and tasks do not consume chat.
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM task_usage WHERE user_id = 1 AND period_start = '2026-10-01'").get().n, 0);
  } finally { sqlite.close(); }
});

test("a paid plan gets its larger daily cap", async () => {
  const { sqlite, d1 } = migratedDatabase({ users: [[1, "alice"]] });
  try {
    sqlite.prepare("INSERT INTO subscriptions (user_id, tier, status) VALUES (1, 'pro', 'active')").run();
    const db = drizzle(d1);
    const first = await checkAndRecordChatUsage(db, 1, NOW);
    assert.equal(first.limit, 400);
    assert.equal(first.remaining, 399);
  } finally { sqlite.close(); }
});
