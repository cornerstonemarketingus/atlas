import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import { consumeRateLimit, enforceRateLimit, rateLimitSubjectForAccount, rateLimitSubjectForDevice, rateLimitSubjectForIp } from "../app/api/rate-limit.mjs";

const requestRateLimits = sqliteTable("request_rate_limits", {
  subject: text("subject").notNull(),
  route: text("route").notNull(),
  bucketStart: integer("bucket_start").notNull(),
  requestCount: integer("request_count").notNull().default(1),
  updatedAt: text("updated_at").notNull(),
}, (table) => ({
  bucketIndex: uniqueIndex("request_rate_limits_subject_route_bucket_idx").on(table.subject, table.route, table.bucketStart),
}));

function database() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE request_rate_limits (
      subject TEXT NOT NULL,
      route TEXT NOT NULL,
      bucket_start INTEGER NOT NULL,
      request_count INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX request_rate_limits_subject_route_bucket_idx
    ON request_rate_limits (subject, route, bucket_start);
  `);
  const db = drizzle(async (statement, params, method) => {
    await new Promise((resolve) => setImmediate(resolve));
    const prepared = sqlite.prepare(statement);
    prepared.setReturnArrays?.(true);
    if (method === "run") {
      prepared.run(...params);
      return { rows: [] };
    }
    const rows = prepared.all(...params).map((row) => (Array.isArray(row) ? row : Object.values(row)));
    return { rows: method === "get" ? rows[0] : rows };
  });
  return { db, sqlite };
}

test("under-budget requests pass until the limit is reached", async () => {
  const { db, sqlite } = database();
  try {
    const first = await consumeRateLimit(db, requestRateLimits, {
      subject: "ip:203.0.113.10",
      route: "auth_operator",
      limit: 2,
      windowSeconds: 60,
      now: 120_000,
    });
    const second = await consumeRateLimit(db, requestRateLimits, {
      subject: "ip:203.0.113.10",
      route: "auth_operator",
      limit: 2,
      windowSeconds: 60,
      now: 120_500,
    });
    assert.equal(first.allowed, true);
    assert.equal(first.remaining, 1);
    assert.equal(second.allowed, true);
    assert.equal(second.remaining, 0);
    assert.equal(sqlite.prepare("SELECT request_count FROM request_rate_limits").get().request_count, 2);
  } finally {
    sqlite.close();
  }
});

test("over-budget requests get a 429 with Retry-After", async () => {
  const { db, sqlite } = database();
  try {
    const request = new Request("https://atlas.test/api/auth/operator", { headers: { "cf-connecting-ip": "203.0.113.11" } });
    const subject = rateLimitSubjectForIp(request);
    assert.equal(await enforceRateLimit({
      db,
      table: requestRateLimits,
      subject,
      route: "auth_operator",
      limit: 1,
      windowSeconds: 60,
      now: 180_000,
    }), null);
    const limited = await enforceRateLimit({
      db,
      table: requestRateLimits,
      subject,
      route: "auth_operator",
      limit: 1,
      windowSeconds: 60,
      now: 180_001,
    });
    assert.equal(limited?.status, 429);
    assert.equal(limited?.headers.get("retry-after"), "60");
    assert.deepEqual(await limited?.json(), { error: "rate_limited" });
    const stillLimited = await enforceRateLimit({
      db,
      table: requestRateLimits,
      subject,
      route: "auth_operator",
      limit: 1,
      windowSeconds: 60,
      now: 180_002,
    });
    assert.equal(stillLimited?.status, 429);
    assert.equal(sqlite.prepare("SELECT request_count FROM request_rate_limits").get().request_count, 2);
  } finally {
    sqlite.close();
  }
});

test("fixed windows reset after the bucket expires", async () => {
  const { db, sqlite } = database();
  try {
    const first = await consumeRateLimit(db, requestRateLimits, {
      subject: "account:github:octocat",
      route: "tasks_post",
      limit: 1,
      windowSeconds: 60,
      now: 59_000,
    });
    const second = await consumeRateLimit(db, requestRateLimits, {
      subject: "account:github:octocat",
      route: "tasks_post",
      limit: 1,
      windowSeconds: 60,
      now: 60_000,
    });
    assert.equal(first.allowed, true);
    assert.equal(second.allowed, true);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM request_rate_limits").get().count, 2);
  } finally {
    sqlite.close();
  }
});

test("account and IP buckets are independent", async () => {
  const { db, sqlite } = database();
  try {
    const request = new Request("https://atlas.test/api/tasks", { headers: { "cf-connecting-ip": "203.0.113.12" } });
    const accountSubject = rateLimitSubjectForAccount({ userId: "github:octocat" });
    const ipSubject = rateLimitSubjectForIp(request);
    assert.equal((await consumeRateLimit(db, requestRateLimits, {
      subject: accountSubject,
      route: "tasks_post",
      limit: 1,
      windowSeconds: 60,
      now: 120_000,
    })).allowed, true);
    assert.equal((await consumeRateLimit(db, requestRateLimits, {
      subject: ipSubject,
      route: "tasks_post",
      limit: 1,
      windowSeconds: 60,
      now: 120_000,
    })).allowed, true);
    assert.equal((await consumeRateLimit(db, requestRateLimits, {
      subject: accountSubject,
      route: "tasks_post",
      limit: 1,
      windowSeconds: 60,
      now: 120_001,
    })).allowed, false);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM request_rate_limits").get().count, 2);
  } finally {
    sqlite.close();
  }
});

test("authenticated devices get their own limiter buckets", () => {
  assert.equal(rateLimitSubjectForDevice({ id: "device-123" }), "device:device-123");
});

test("IP subjects fall back to forwarded headers and skip untrusted unknown callers", () => {
  assert.equal(rateLimitSubjectForIp(new Request("https://atlas.test", { headers: { "x-forwarded-for": "203.0.113.20, 198.51.100.9" } })), "ip:203.0.113.20");
  assert.equal(rateLimitSubjectForIp(new Request("https://atlas.test")), null);
});

test("operator sign-in fails closed when limiter storage is unavailable", async () => {
  const limited = await enforceRateLimit({
    db() { throw new Error("D1 unavailable"); },
    table: requestRateLimits,
    request: new Request("https://atlas.test/api/auth/operator", { headers: { "cf-connecting-ip": "203.0.113.13" } }),
    subject: "ip:203.0.113.13",
    route: "auth_operator",
    limit: 5,
    windowSeconds: 15 * 60,
    failClosed: true,
  });
  assert.equal(limited?.status, 429);
  assert.equal(limited?.headers.get("retry-after"), "900");
  assert.deepEqual(await limited?.json(), { error: "rate_limited" });
});

test("migration 0015 creates the hosted rate-limit table and journal entry", () => {
  const sql = fs.readFileSync(new URL("../drizzle/0015_hosted_rate_limits.sql", import.meta.url), "utf8");
  const journal = JSON.parse(fs.readFileSync(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8"));
  const entry = journal.entries.find((item) => item.tag === "0015_hosted_rate_limits");
  assert.equal(entry?.idx, 15);
  const sqlite = new DatabaseSync(":memory:");
  try {
    sqlite.exec(sql);
    sqlite.prepare("INSERT INTO request_rate_limits (subject, route, bucket_start, request_count, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run("ip:203.0.113.14", "auth_operator", 0, 1, "2026-09-26T00:00:00.000Z");
    assert.throws(() => sqlite.prepare("INSERT INTO request_rate_limits (subject, route, bucket_start, request_count, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run("ip:203.0.113.14", "auth_operator", 0, 2, "2026-09-26T00:00:01.000Z"), /UNIQUE/u);
  } finally {
    sqlite.close();
  }
});
