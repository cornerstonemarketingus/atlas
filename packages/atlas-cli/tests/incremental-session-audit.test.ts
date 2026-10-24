import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { InMemorySessionAuditLog } from "../src/infrastructure/in-memory-session-audit-log.js";
import { JsonLinesSessionAuditStore } from "../src/infrastructure/json-lines-session-audit-store.js";
import { PatternSecretRedactor } from "../src/infrastructure/pattern-secret-redactor.js";
import { IncrementalSessionAuditWriter } from "../src/infrastructure/persist-session-audit.js";

test("incremental audit keeps redacted ordered events before completion without duplicate final writes", async t => {
  const root = await mkdtemp(join(tmpdir(), "atlas-live-audit-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const filePath = join(root, "audit.jsonl");
  const audit = new InMemorySessionAuditLog({ clock: () => new Date("2026-10-22T00:00:00Z") });
  const store = new JsonLinesSessionAuditStore({ filePath, redactor: new PatternSecretRedactor() });
  const writer = new IncrementalSessionAuditWriter(store, audit);
  const secret = "ghp_0123456789abcdefghijABCDEFGHIJ0123";
  audit.append("session.started", { sessionId: "s1" });
  audit.append("tool.policy_decided", { toolCallId: "t1", decision: "allow", reason: `Inspect ${secret}` });
  await Promise.all([writer.flush(), writer.flush()]);
  assert.equal((await new JsonLinesSessionAuditStore({ filePath }).load()).length, 2);
  assert.ok(!(await readFile(filePath, "utf8")).includes(secret));
  audit.append("session.failed", { sessionId: "s1", summary: "deadline" });
  assert.deepEqual(await writer.flush(), { persisted: 3 });
  assert.deepEqual(await writer.flush(), { persisted: 3 });
  const events = await new JsonLinesSessionAuditStore({ filePath }).load();
  assert.deepEqual(events.map(event => event.sequence), [1, 2, 3]);
  assert.ok(events.every(event => event.occurredAt === "2026-10-22T00:00:00.000Z"));
});

test("events arriving during a flush drain through the same writer", async () => {
  const audit = new InMemorySessionAuditLog();
  audit.append("session.started", { sessionId: "s1" });
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const calls: string[] = [];
  const writer = new IncrementalSessionAuditWriter({ append: async (type, payload) => {
    calls.push(type);
    if (calls.length === 1) await held;
    return { schemaVersion: 1, sequence: calls.length, occurredAt: new Date().toISOString(), type, payload };
  } }, audit);
  const pending = writer.flush();
  audit.append("session.failed", { sessionId: "s1", summary: "interrupted" });
  const concurrent = writer.flush();
  release();
  assert.deepEqual(await pending, { persisted: 2 });
  assert.deepEqual(await concurrent, { persisted: 2 });
  assert.deepEqual(calls, ["session.started", "session.failed"]);
});

test("a failed append retains the confirmed prefix and is never retried", async t => {
  const root = await mkdtemp(join(tmpdir(), "atlas-live-audit-failure-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const audit = new InMemorySessionAuditLog();
  audit.append("session.started", { sessionId: "s1" });
  audit.append("session.failed", { sessionId: "s1", summary: "failed" });
  const store = new JsonLinesSessionAuditStore({ filePath: join(root, "audit.jsonl"), maxEvents: 1 });
  const writer = new IncrementalSessionAuditWriter(store, audit);
  const result = await writer.flush();
  assert.equal(result.persisted, 1);
  assert.match(result.error ?? "", /limit/u);
  assert.deepEqual(await writer.flush(), result);
  assert.equal((await store.load()).length, 1);
  assert.equal(audit.size, 2, "storage failure does not discard in-memory evidence");
});
