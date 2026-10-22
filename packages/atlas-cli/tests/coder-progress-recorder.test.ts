import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { CoderProgressRecorder } from "../src/infrastructure/coder-progress-recorder.js";
import { InMemorySessionAuditLog } from "../src/infrastructure/in-memory-session-audit-log.js";

test("incremental checkpoints survive interruption without duplicating audit events", async t => {
  const root = await mkdtemp(join(tmpdir(), "atlas-progress-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const audit = new InMemorySessionAuditLog();
  const filePath = join(root, "progress.json");
  const auditLogPath = join(root, "audit.jsonl");
  let saves = 0;
  const recorder = new CoderProgressRecorder({ filePath, auditLogPath, audit, checkpoint: async () => { saves++; } });
  audit.append("session.started", { sessionId: "fixture" });
  await recorder.save({ schemaVersion: 1, status: "running", edits: [{ path: "source.txt", operation: "update" }] });
  const first = JSON.parse(await readFile(filePath, "utf8"));
  assert.equal(first.status, "running");
  assert.equal(first.edits[0].path, "source.txt");
  audit.append("session.failed", { sessionId: "fixture", summary: "deadline" });
  await Promise.all([recorder.save({ status: "stopped" }), recorder.save({ status: "failed" })]);
  assert.equal(JSON.parse(await readFile(filePath, "utf8")).status, "failed");
  assert.equal((await readFile(auditLogPath, "utf8")).trim().split("\n").length, 2);
  assert.equal(saves, 3);
});

test("redaction failure preserves the last usable checkpoint and future saves can recover", async t => {
  const root = await mkdtemp(join(tmpdir(), "atlas-progress-redact-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const filePath = join(root, "progress.json");
  await writeFile(filePath, '{"status":"last usable"}\n');
  const recorder = new CoderProgressRecorder({ filePath, redactor: { redact: async () => ({ schemaVersion: 1, scannedCharacters: 0, text: "incomplete", truncated: true, redactionCount: 0, findings: [] }) } });
  await assert.rejects(recorder.save({ status: "running" }), /redaction bound/);
  assert.equal(JSON.parse(await readFile(filePath, "utf8")).status, "last usable");
});
