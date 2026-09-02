import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { JsonLinesSessionAuditStore, SessionAuditStorageError } from "../src/infrastructure/json-lines-session-audit-store.js";
import { PatternSecretRedactor } from "../src/infrastructure/pattern-secret-redactor.js";

async function pathFor(name: string): Promise<string> {
  const parent = join(await mkdtemp(join(tmpdir(), "atlas-audit-")), "nested");
  await mkdir(parent);
  return join(parent, name);
}

test("persists and reloads metadata events in sequence", async () => {
  const filePath = await pathFor("events.jsonl");
  const store = new JsonLinesSessionAuditStore({ filePath, clock: () => new Date("2026-01-02T03:04:05Z") });
  await store.append("session.started", { sessionId: "s1", repositoryId: "repo" });
  await store.append("session.completed", { sessionId: "s1", summary: "done" });
  const loaded = await new JsonLinesSessionAuditStore({ filePath }).load();
  assert.deepEqual(loaded.map(({ sequence, type }) => ({ sequence, type })), [
    { sequence: 1, type: "session.started" }, { sequence: 2, type: "session.completed" },
  ]);
  assert.equal((await readFile(filePath, "utf8")).split("\n").filter(Boolean).length, 2);
});

test("serializes concurrent appends within a process", async () => {
  const filePath = await pathFor("events.jsonl");
  const store = new JsonLinesSessionAuditStore({ filePath });
  const events = await Promise.all(Array.from({ length: 20 }, (_, index) => store.append("error.recorded", { code: `E${index}`, summary: "metadata", recoverable: true })));
  assert.deepEqual(events.map((event) => event.sequence), Array.from({ length: 20 }, (_, index) => index + 1));
  assert.equal((await new JsonLinesSessionAuditStore({ filePath }).load()).length, 20);
});

test("rejects malformed records and non-monotonic sequences", async () => {
  const malformed = await pathFor("malformed.jsonl");
  await writeFile(malformed, "{not-json}\n");
  await assert.rejects(() => new JsonLinesSessionAuditStore({ filePath: malformed }).load(), (error: unknown) => error instanceof SessionAuditStorageError && error.code === "AUDIT_INVALID_EVENT");
  const sequence = await pathFor("sequence.jsonl");
  await writeFile(sequence, `${JSON.stringify({ schemaVersion: 1, sequence: 2, occurredAt: new Date().toISOString(), type: "session.started", payload: { sessionId: "s" } })}\n`);
  await assert.rejects(() => new JsonLinesSessionAuditStore({ filePath: sequence }).load(), (error: unknown) => error instanceof SessionAuditStorageError && error.code === "AUDIT_INVALID_SEQUENCE");
});

test("handles a malformed truncated tail according to explicit policy", async () => {
  const filePath = await pathFor("events.jsonl");
  const valid = JSON.stringify({ schemaVersion: 1, sequence: 1, occurredAt: new Date().toISOString(), type: "session.started", payload: { sessionId: "s" } });
  await writeFile(filePath, `${valid}\n{"schemaVersion":`);
  await assert.rejects(() => new JsonLinesSessionAuditStore({ filePath }).load(), (error: unknown) => error instanceof SessionAuditStorageError && error.code === "AUDIT_TRUNCATED_TAIL");
  const loaded = await new JsonLinesSessionAuditStore({ filePath, truncatedTailPolicy: "ignore" }).load();
  assert.equal(loaded.length, 1);
});

test("enforces event, line, and file bounds", async () => {
  const eventFile = await pathFor("event.jsonl");
  const eventStore = new JsonLinesSessionAuditStore({ filePath: eventFile, maxEvents: 1 });
  await eventStore.append("session.started", { sessionId: "s" });
  await assert.rejects(() => eventStore.append("session.completed", { sessionId: "s", summary: "done" }), (error: unknown) => error instanceof SessionAuditStorageError && error.code === "AUDIT_EVENT_LIMIT_EXCEEDED");
  const lineStore = new JsonLinesSessionAuditStore({ filePath: await pathFor("line.jsonl"), maxLineBytes: 100 });
  await assert.rejects(() => lineStore.append("session.completed", { sessionId: "s", summary: "x".repeat(200) }), (error: unknown) => error instanceof SessionAuditStorageError && error.code === "AUDIT_LINE_TOO_LARGE");
  const largeFile = await pathFor("large.jsonl");
  await writeFile(largeFile, "x".repeat(101));
  await assert.rejects(() => new JsonLinesSessionAuditStore({ filePath: largeFile, maxFileBytes: 100 }).load(), (error: unknown) => error instanceof SessionAuditStorageError && error.code === "AUDIT_FILE_TOO_LARGE");
});

test("rejects payload fields outside the metadata-only event contract", async () => {
  const filePath = await pathFor("secret.jsonl");
  await writeFile(filePath, `${JSON.stringify({ schemaVersion: 1, sequence: 1, occurredAt: new Date().toISOString(), type: "session.started", payload: { sessionId: "s", prompt: "raw" } })}\n`);
  await assert.rejects(() => new JsonLinesSessionAuditStore({ filePath }).load(), (error: unknown) => error instanceof SessionAuditStorageError && error.code === "AUDIT_INVALID_EVENT");
});

const AUDIT_SECRET = "ghp_0123456789abcdefghijABCDEFGHIJ0123";

test("scrubs credentials out of the free-text fields an audit event carries", async () => {
  // Session events are metadata by design, but four payload fields carry free
  // text quoting real content. An audit trail is written to be read later, by
  // someone reconstructing a session, so a credential landing in one is durable
  // and widely readable.
  const filePath = await pathFor("redacted.jsonl");
  const store = new JsonLinesSessionAuditStore({ filePath, redactor: new PatternSecretRedactor() });

  await store.append("session.completed", { sessionId: "s1", summary: `Rotated ${AUDIT_SECRET} in config.ts` });
  await store.append("error.recorded", { code: "E", summary: `parse failed near ${AUDIT_SECRET}`, recoverable: true });
  await store.append("tool.policy_decided", { toolCallId: "t1", decision: "deny", reason: `blocked ${AUDIT_SECRET}` });
  await store.append("approval.recorded", { approvalId: "a1", toolCallId: "t1", decision: "rejected", reason: AUDIT_SECRET });

  const onDisk = await readFile(filePath, "utf8");
  assert.equal(onDisk.includes(AUDIT_SECRET), false, "the credential was written to the audit file");
  assert.equal((onDisk.match(/\[redacted:github-token:[0-9a-f]+\]/gu) ?? []).length, 4);
});

test("returns and reloads exactly what it wrote, not the unredacted original", async () => {
  // If the returned event kept the raw text while disk held the placeholder,
  // an in-process reader would see the secret and a later reload would not —
  // the kind of split that makes an audit trail untrustworthy.
  const filePath = await pathFor("consistent.jsonl");
  const store = new JsonLinesSessionAuditStore({ filePath, redactor: new PatternSecretRedactor() });

  const returned = await store.append("session.completed", { sessionId: "s1", summary: `token ${AUDIT_SECRET}` });
  assert.equal(returned.payload.summary.includes(AUDIT_SECRET), false);

  const reloaded = await new JsonLinesSessionAuditStore({ filePath }).load();
  assert.deepEqual(reloaded[0], returned);
});

test("leaves an event with nothing to redact byte-identical", async () => {
  const plain = await pathFor("plain.jsonl");
  const redacted = await pathFor("redacted-noop.jsonl");
  const clock = () => new Date("2026-01-02T03:04:05Z");
  await new JsonLinesSessionAuditStore({ filePath: plain, clock })
    .append("session.completed", { sessionId: "s1", summary: "nothing sensitive" });
  await new JsonLinesSessionAuditStore({ filePath: redacted, clock, redactor: new PatternSecretRedactor() })
    .append("session.completed", { sessionId: "s1", summary: "nothing sensitive" });

  assert.equal(await readFile(redacted, "utf8"), await readFile(plain, "utf8"));
});

test("refuses to append rather than storing a corrupted audit record", async () => {
  // A bounded scan that drops the tail can leave the serialized event
  // unparseable. Storing the fragment as an opaque string would quietly
  // corrupt the trail, so this fails loudly instead.
  const filePath = await pathFor("corrupt.jsonl");
  const store = new JsonLinesSessionAuditStore({
    filePath,
    redactor: { redact: async (text) => ({
      schemaVersion: 1,
      text: text.slice(0, 12),
      redactionCount: 1,
      findings: [],
      scannedCharacters: 12,
      truncated: true,
    }) },
  });

  await assert.rejects(
    store.append("session.completed", { sessionId: "s1", summary: "x" }),
    (error: unknown) => error instanceof SessionAuditStorageError && error.code === "AUDIT_INVALID_EVENT",
  );
  await assert.rejects(readFile(filePath, "utf8"), { code: "ENOENT" });
});

test("propagates a redactor fault instead of writing the raw event", async () => {
  const filePath = await pathFor("failing.jsonl");
  const store = new JsonLinesSessionAuditStore({
    filePath,
    redactor: { redact: () => Promise.reject(new Error("digest unavailable")) },
  });

  await assert.rejects(store.append("session.completed", { sessionId: "s1", summary: AUDIT_SECRET }), /digest unavailable/u);
  await assert.rejects(readFile(filePath, "utf8"), { code: "ENOENT" });
});
