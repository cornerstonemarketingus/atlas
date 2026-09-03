import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { InMemorySessionAuditLog } from "../src/infrastructure/in-memory-session-audit-log.js";
import { JsonLinesSessionAuditStore } from "../src/infrastructure/json-lines-session-audit-store.js";
import { PatternSecretRedactor } from "../src/infrastructure/pattern-secret-redactor.js";
import { persistSessionAudit } from "../src/infrastructure/persist-session-audit.js";
import type { SessionAuditLog } from "../src/domain/session-audit.js";

const SECRET = "ghp_0123456789abcdefghijABCDEFGHIJ0123";

async function pathFor(name: string): Promise<string> {
  const parent = join(await mkdtemp(join(tmpdir(), "atlas-persist-")), "nested");
  await mkdir(parent);
  return join(parent, name);
}

/** A session log with events at distinct, known times. */
function sessionLog(): InMemorySessionAuditLog {
  let tick = 0;
  const log = new InMemorySessionAuditLog({
    clock: () => new Date(Date.parse("2026-03-01T10:00:00.000Z") + tick++ * 1_500),
  });
  log.append("session.started", { sessionId: "s1", repositoryId: "repo" });
  log.append("tool.policy_decided", { toolCallId: "t1", decision: "allow", reason: "read allowed" });
  log.append("session.completed", { sessionId: "s1", summary: "completed" });
  return log;
}

test("writes every event, keeping each one's original time", async () => {
  // Stamping write-time would collapse the whole session into one instant and
  // destroy the ordering and durations that make a trace worth keeping.
  const filePath = await pathFor("audit.jsonl");
  const log = sessionLog();

  const result = await persistSessionAudit(new JsonLinesSessionAuditStore({ filePath }), log);
  assert.deepEqual(result, { persisted: 3 });

  const reloaded = await new JsonLinesSessionAuditStore({ filePath }).load();
  assert.deepEqual(reloaded.map((event) => event.type), [
    "session.started",
    "tool.policy_decided",
    "session.completed",
  ]);
  assert.deepEqual(
    reloaded.map((event) => event.occurredAt),
    log.snapshot().map((event) => event.occurredAt),
  );
  assert.deepEqual(reloaded.map((event) => event.sequence), [1, 2, 3]);
});

test("scrubs credentials out of the persisted trace", async () => {
  const filePath = await pathFor("redacted.jsonl");
  const log = new InMemorySessionAuditLog();
  log.append("session.completed", { sessionId: "s1", summary: `rotated ${SECRET}` });

  const result = await persistSessionAudit(
    new JsonLinesSessionAuditStore({ filePath, redactor: new PatternSecretRedactor() }),
    log,
  );
  assert.equal(result.persisted, 1);
  const onDisk = await readFile(filePath, "utf8");
  assert.equal(onDisk.includes(SECRET), false);
  assert.match(onDisk, /\[redacted:github-token:[0-9a-f]+\]/u);
});

test("continues an existing log's numbering rather than replaying a foreign one", async () => {
  // The file is the authority for its own ordering, so a second flush appends
  // rather than restarting at 1 and making the log unloadable.
  const filePath = await pathFor("appended.jsonl");
  await persistSessionAudit(new JsonLinesSessionAuditStore({ filePath }), sessionLog());
  const second = await persistSessionAudit(new JsonLinesSessionAuditStore({ filePath }), sessionLog());
  assert.equal(second.persisted, 3);

  const reloaded = await new JsonLinesSessionAuditStore({ filePath }).load();
  assert.deepEqual(reloaded.map((event) => event.sequence), [1, 2, 3, 4, 5, 6]);
});

test("never throws when persistence fails, and reports how much landed", async () => {
  // A run that produced a correct change and a pull request has not failed
  // because its audit trail could not be written. Losing the record is bad;
  // discarding the work is worse.
  const filePath = await pathFor("capped.jsonl");
  const store = new JsonLinesSessionAuditStore({ filePath, maxEvents: 2 });

  const result = await persistSessionAudit(store, sessionLog());
  assert.equal(result.persisted, 2, "the two that fit should have landed");
  assert.ok(result.error, "the failure should be reported, not raised");
  assert.match(result.error ?? "", /limit/iu);

  // The partial log is still a valid, loadable record.
  const reloaded = await new JsonLinesSessionAuditStore({ filePath }).load();
  assert.equal(reloaded.length, 2);
});

test("reports a store that fails on the very first append", async () => {
  const failing = {
    append: () => Promise.reject(new Error("disk on fire")),
  } as unknown as JsonLinesSessionAuditStore;
  const result = await persistSessionAudit(failing, sessionLog());
  assert.deepEqual(result, { persisted: 0, error: "disk on fire" });
});

test("writes nothing for a session that recorded nothing", async () => {
  const filePath = await pathFor("empty.jsonl");
  const empty: SessionAuditLog = new InMemorySessionAuditLog();
  const result = await persistSessionAudit(new JsonLinesSessionAuditStore({ filePath }), empty);
  assert.deepEqual(result, { persisted: 0 });
  await assert.rejects(readFile(filePath, "utf8"), { code: "ENOENT" });
});

test("rejects a malformed timestamp instead of writing an unloadable line", async () => {
  // One bad flush must not cost the entire audit trail: a line that fails
  // validation on read would make the whole file unloadable.
  const filePath = await pathFor("bad-time.jsonl");
  const store = new JsonLinesSessionAuditStore({ filePath });
  await assert.rejects(
    store.append("session.completed", { sessionId: "s1", summary: "x" }, "not-a-timestamp"),
    /Invalid occurredAt/u,
  );
  await assert.rejects(readFile(filePath, "utf8"), { code: "ENOENT" });
});
