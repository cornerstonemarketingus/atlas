import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { captureCoderRecovery, readCoderProgress } from "./coder-recovery.mjs";

test("a killed coder's tracked and newly created changes remain reviewable", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-recovery-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const git = (...args) => {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git("init");
  fs.writeFileSync(path.join(root, "source.txt"), "before\n");
  git("add", "source.txt");
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "base");
  const baseCommit = git("rev-parse", "HEAD");
  fs.writeFileSync(path.join(root, "source.txt"), "after\n");
  fs.writeFileSync(path.join(root, "new.txt"), "new file\n");
  fs.writeFileSync(path.join(root, "renamed.txt"), "renamed destination\n");
  const result = captureCoderRecovery(root, baseCommit, [{ path: "new.txt", operation: "create" }, { path: "renamed.txt", operation: "rename" }, { path: "new.txt", operation: "create" }, { path: "../outside", operation: "create" }]);
  assert.equal(result.completionConfirmed, false);
  assert.match(result.trackedDiff, /-before\n\+after/);
  assert.deepEqual(result.untracked, [{ path: "new.txt", content: "new file\n" }, { path: "renamed.txt", content: "renamed destination\n" }]);
  assert.equal(fs.readFileSync(path.join(root, "source.txt"), "utf8"), "after\n");
});

test("checkpoint reads reject corrupt, oversized and symlinked snapshots", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-progress-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const filename = path.join(root, "progress.json");
  assert.equal(readCoderProgress(filename), null);
  fs.writeFileSync(filename, '{"schemaVersion":1,"edits":');
  assert.equal(readCoderProgress(filename), null);
  fs.writeFileSync(filename, JSON.stringify({ schemaVersion: 1, edits: [{ path: "new.txt", operation: "create" }] }));
  assert.equal(readCoderProgress(filename).edits.length, 1);
  if (process.platform !== "win32") {
    const link = path.join(root, "linked.json");
    fs.symlinkSync(filename, link);
    assert.equal(readCoderProgress(link), null);
  }
  fs.writeFileSync(filename, "x".repeat(2 * 1024 * 1024 + 1));
  assert.equal(readCoderProgress(filename), null);
});
