import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { RepositoryChangeSetError } from "../src/domain/repository-change-set.js";
import { RepositoryFileEditError } from "../src/domain/repository-file-edit.js";
import { SafeRepositoryFileEditor } from "../src/infrastructure/safe-repository-file-editor.js";
import { TransactionalRepositoryChangeSetEditor } from "../src/infrastructure/transactional-repository-change-set-editor.js";

const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "atlas-change-set-"));
  await mkdir(join(root, "src"));
  return root;
}
function code(error: unknown): string | undefined { return error instanceof RepositoryChangeSetError ? error.code : undefined; }
function editCode(error: unknown): string | undefined { return error instanceof RepositoryFileEditError ? error.code : undefined; }

test("previews a multi-file change set without mutation and applies its approved digest", async () => {
  const root = await fixture();
  await writeFile(join(root, "src/existing.ts"), "before\n");
  const editor = new TransactionalRepositoryChangeSetEditor(new SafeRepositoryFileEditor());
  const plan = await editor.preview(root, [
    { operation: "update", path: "src/existing.ts", content: "after\n", expectedSha256: hash("before\n") },
    { operation: "create", path: "src/new.ts", content: "new\n", mustNotExist: true },
  ]);
  assert.equal(await readFile(join(root, "src/existing.ts"), "utf8"), "before\n");
  await assert.rejects(readFile(join(root, "src/new.ts")), { code: "ENOENT" });
  const result = await editor.apply(plan, { approved: true, changeSetDigest: plan.changeSetDigest });
  assert.equal(result.rollbackStatus, "not-needed");
  assert.equal(result.applied.length, 2);
  assert.equal(await readFile(join(root, "src/existing.ts"), "utf8"), "after\n");
  assert.equal(await readFile(join(root, "src/new.ts"), "utf8"), "new\n");
});

test("rolls back prior edits when a later edit becomes stale", async () => {
  const root = await fixture();
  await writeFile(join(root, "src/first.ts"), "first-before\n");
  await writeFile(join(root, "src/second.ts"), "second-before\n");
  const editor = new TransactionalRepositoryChangeSetEditor(new SafeRepositoryFileEditor());
  const plan = await editor.preview(root, [
    { operation: "update", path: "src/first.ts", content: "first-after\n", expectedSha256: hash("first-before\n") },
    { operation: "update", path: "src/second.ts", content: "second-after\n", expectedSha256: hash("second-before\n") },
  ]);
  await writeFile(join(root, "src/second.ts"), "raced\n");
  const result = await editor.apply(plan, { approved: true, changeSetDigest: plan.changeSetDigest });
  assert.equal(result.rollbackStatus, "rolled-back");
  assert.deepEqual(result.rolledBackPaths, ["src/first.ts"]);
  assert.equal(result.failure?.code, "STALE_FILE");
  assert.equal(await readFile(join(root, "src/first.ts"), "utf8"), "first-before\n");
  assert.equal(await readFile(join(root, "src/second.ts"), "utf8"), "raced\n");
});

test("rolls back a created file when a later edit fails", async () => {
  const root = await fixture();
  await writeFile(join(root, "src/existing.ts"), "before\n");
  const editor = new TransactionalRepositoryChangeSetEditor(new SafeRepositoryFileEditor());
  const plan = await editor.preview(root, [
    { operation: "create", path: "src/new.ts", content: "new\n", mustNotExist: true },
    { operation: "update", path: "src/existing.ts", content: "after\n", expectedSha256: hash("before\n") },
  ]);
  await writeFile(join(root, "src/existing.ts"), "raced\n");
  const result = await editor.apply(plan, { approved: true, changeSetDigest: plan.changeSetDigest });
  assert.equal(result.rollbackStatus, "rolled-back");
  assert.deepEqual(result.rolledBackPaths, ["src/new.ts"]);
  await assert.rejects(readFile(join(root, "src/new.ts")), { code: "ENOENT" });
});

test("rejects tampered approval and duplicate paths", async () => {
  const root = await fixture();
  const editor = new TransactionalRepositoryChangeSetEditor(new SafeRepositoryFileEditor());
  await assert.rejects(editor.preview(root, [
    { operation: "create", path: "src/a.ts", content: "one", mustNotExist: true },
    { operation: "create", path: "src/a.ts", content: "two", mustNotExist: true },
  ]), (error) => code(error) === "DUPLICATE_PATH");
  const plan = await editor.preview(root, [{ operation: "create", path: "src/a.ts", content: "one", mustNotExist: true }]);
  await assert.rejects(editor.apply(plan, { approved: true, changeSetDigest: "0".repeat(64) }), (error) => code(error) === "APPROVAL_MISMATCH");
});

test("bounds pending change sets and discards nested file plans", async () => {
  const root = await fixture();
  const editor = new TransactionalRepositoryChangeSetEditor(new SafeRepositoryFileEditor(), { maxPendingChangeSets: 1 });
  const first = await editor.preview(root, [{ operation: "create", path: "src/one.ts", content: "one", mustNotExist: true }]);
  await assert.rejects(editor.preview(root, [{ operation: "create", path: "src/two.ts", content: "two", mustNotExist: true }]), (error) => code(error) === "PLAN_CAPACITY_REACHED");
  assert.equal(editor.discard(first.changeSetDigest), true);
  await editor.preview(root, [{ operation: "create", path: "src/two.ts", content: "two", mustNotExist: true }]);
});

test("applies creates, updates, deletes, and renames as one transaction", async () => {
  const root = await fixture();
  await writeFile(join(root, "src/keep.ts"), "before\n");
  await writeFile(join(root, "src/gone.ts"), "obsolete\n");
  await writeFile(join(root, "src/old-name.ts"), "moved\n");
  const editor = new TransactionalRepositoryChangeSetEditor(new SafeRepositoryFileEditor());
  const plan = await editor.preview(root, [
    { operation: "update", path: "src/keep.ts", content: "after\n", expectedSha256: hash("before\n") },
    { operation: "delete", path: "src/gone.ts", expectedSha256: hash("obsolete\n") },
    { operation: "rename", path: "src/old-name.ts", toPath: "src/new-name.ts", expectedSha256: hash("moved\n") },
    { operation: "create", path: "src/added.ts", content: "added\n", mustNotExist: true },
  ]);
  // Nothing may touch the working tree until apply.
  assert.equal(await readFile(join(root, "src/gone.ts"), "utf8"), "obsolete\n");
  assert.equal(await readFile(join(root, "src/old-name.ts"), "utf8"), "moved\n");

  const result = await editor.apply(plan, { approved: true, changeSetDigest: plan.changeSetDigest });
  assert.equal(result.rollbackStatus, "not-needed");
  assert.equal(result.applied.length, 4);
  assert.equal(await readFile(join(root, "src/keep.ts"), "utf8"), "after\n");
  await assert.rejects(readFile(join(root, "src/gone.ts")), { code: "ENOENT" });
  await assert.rejects(readFile(join(root, "src/old-name.ts")), { code: "ENOENT" });
  assert.equal(await readFile(join(root, "src/new-name.ts"), "utf8"), "moved\n");
  assert.equal(await readFile(join(root, "src/added.ts"), "utf8"), "added\n");
});

test("restores every prior edit, including deleted bytes, when a later edit fails", async () => {
  const root = await fixture();
  // CRLF proves the restore is byte-exact rather than a newline-normalizing replay.
  await writeFile(join(root, "src/deleted.ts"), "one\r\ntwo\r\n");
  await writeFile(join(root, "src/updated.ts"), "update-before\n");
  await writeFile(join(root, "src/raced.ts"), "raced-before\n");
  const editor = new TransactionalRepositoryChangeSetEditor(new SafeRepositoryFileEditor());
  const plan = await editor.preview(root, [
    { operation: "create", path: "src/created.ts", content: "created\n", mustNotExist: true },
    { operation: "delete", path: "src/deleted.ts", expectedSha256: hash("one\r\ntwo\r\n") },
    { operation: "update", path: "src/updated.ts", content: "update-after\n", expectedSha256: hash("update-before\n") },
    { operation: "update", path: "src/raced.ts", content: "never\n", expectedSha256: hash("raced-before\n") },
  ]);
  await writeFile(join(root, "src/raced.ts"), "raced-by-someone-else\n");

  const result = await editor.apply(plan, { approved: true, changeSetDigest: plan.changeSetDigest });
  assert.equal(result.rollbackStatus, "rolled-back");
  assert.equal(result.failure?.code, "STALE_FILE");
  assert.deepEqual(result.rolledBackPaths, ["src/updated.ts", "src/deleted.ts", "src/created.ts"]);
  await assert.rejects(readFile(join(root, "src/created.ts")), { code: "ENOENT" });
  assert.equal(await readFile(join(root, "src/deleted.ts"), "utf8"), "one\r\ntwo\r\n");
  assert.equal(await readFile(join(root, "src/updated.ts"), "utf8"), "update-before\n");
  assert.equal(await readFile(join(root, "src/raced.ts"), "utf8"), "raced-by-someone-else\n");
});

test("rolls a rename back to its original path", async () => {
  const root = await fixture();
  await writeFile(join(root, "src/old-name.ts"), "moved\n");
  await writeFile(join(root, "src/raced.ts"), "raced-before\n");
  const editor = new TransactionalRepositoryChangeSetEditor(new SafeRepositoryFileEditor());
  const plan = await editor.preview(root, [
    { operation: "rename", path: "src/old-name.ts", toPath: "src/new-name.ts", expectedSha256: hash("moved\n") },
    { operation: "update", path: "src/raced.ts", content: "never\n", expectedSha256: hash("raced-before\n") },
  ]);
  await writeFile(join(root, "src/raced.ts"), "raced-by-someone-else\n");

  const result = await editor.apply(plan, { approved: true, changeSetDigest: plan.changeSetDigest });
  assert.equal(result.rollbackStatus, "rolled-back");
  assert.deepEqual(result.rolledBackPaths, ["src/old-name.ts"]);
  assert.equal(await readFile(join(root, "src/old-name.ts"), "utf8"), "moved\n");
  await assert.rejects(readFile(join(root, "src/new-name.ts")), { code: "ENOENT" });
});

test("rejects a concurrent modification of a delete or rename source", async () => {
  const root = await fixture();
  await writeFile(join(root, "src/gone.ts"), "obsolete\n");
  await writeFile(join(root, "src/old-name.ts"), "moved\n");
  const editor = new TransactionalRepositoryChangeSetEditor(new SafeRepositoryFileEditor());
  const plan = await editor.preview(root, [
    { operation: "delete", path: "src/gone.ts", expectedSha256: hash("obsolete\n") },
    { operation: "rename", path: "src/old-name.ts", toPath: "src/new-name.ts", expectedSha256: hash("moved\n") },
  ]);
  await writeFile(join(root, "src/gone.ts"), "someone-else-edited-me\n");

  const result = await editor.apply(plan, { approved: true, changeSetDigest: plan.changeSetDigest });
  assert.equal(result.failure?.code, "STALE_FILE");
  assert.equal(result.applied.length, 0);
  assert.equal(await readFile(join(root, "src/gone.ts"), "utf8"), "someone-else-edited-me\n");
  assert.equal(await readFile(join(root, "src/old-name.ts"), "utf8"), "moved\n");
  await assert.rejects(readFile(join(root, "src/new-name.ts")), { code: "ENOENT" });
  // A digest whose plans were consumed cannot be replayed.
  await assert.rejects(editor.apply(plan, { approved: true, changeSetDigest: plan.changeSetDigest }), (error) => code(error) === "INVALID_PLAN");
});

test("refuses to clobber an existing rename destination", async () => {
  const root = await fixture();
  await writeFile(join(root, "src/old-name.ts"), "moved\n");
  await writeFile(join(root, "src/taken.ts"), "occupied\n");
  const editor = new TransactionalRepositoryChangeSetEditor(new SafeRepositoryFileEditor());
  await assert.rejects(editor.preview(root, [
    { operation: "rename", path: "src/old-name.ts", toPath: "src/taken.ts", expectedSha256: hash("moved\n") },
  ]), (error) => editCode(error) === "FILE_ALREADY_EXISTS");
  assert.equal(await readFile(join(root, "src/taken.ts"), "utf8"), "occupied\n");
});

test("rejects traversal and symlinks, including through a rename destination", async (t) => {
  const root = await fixture();
  const outside = await fixture();
  await writeFile(join(root, "src/source.ts"), "source\n");
  const editor = new TransactionalRepositoryChangeSetEditor(new SafeRepositoryFileEditor());
  await assert.rejects(editor.preview(root, [
    { operation: "delete", path: "../escape.ts", expectedSha256: hash("x") },
  ]), (error) => editCode(error) === "PATH_OUTSIDE_REPOSITORY");
  await assert.rejects(editor.preview(root, [
    { operation: "rename", path: "src/source.ts", toPath: "../escape.ts", expectedSha256: hash("source\n") },
  ]), (error) => editCode(error) === "PATH_OUTSIDE_REPOSITORY");
  await assert.rejects(editor.preview(root, [
    { operation: "rename", path: "src/source.ts", toPath: join(root, "absolute.ts"), expectedSha256: hash("source\n") },
  ]), (error) => editCode(error) === "ABSOLUTE_PATH_NOT_ALLOWED");

  try { await symlink(outside, join(root, "linked"), "junction"); } catch { t.skip("Symlink creation is unavailable"); return; }
  await assert.rejects(editor.preview(root, [
    { operation: "rename", path: "src/source.ts", toPath: "linked/escape.ts", expectedSha256: hash("source\n") },
  ]), (error) => editCode(error) === "SYMLINK_NOT_ALLOWED");
  await assert.rejects(editor.preview(root, [
    { operation: "delete", path: "linked/escape.ts", expectedSha256: hash("x") },
  ]), (error) => editCode(error) === "SYMLINK_NOT_ALLOWED");
  assert.equal(await readFile(join(root, "src/source.ts"), "utf8"), "source\n");
});

test("claims a rename destination so no other edit in the set can touch it", async () => {
  const root = await fixture();
  await writeFile(join(root, "src/old-name.ts"), "moved\n");
  const editor = new TransactionalRepositoryChangeSetEditor(new SafeRepositoryFileEditor());
  await assert.rejects(editor.preview(root, [
    { operation: "rename", path: "src/old-name.ts", toPath: "src/new-name.ts", expectedSha256: hash("moved\n") },
    { operation: "create", path: "src/new-name.ts", content: "collision\n", mustNotExist: true },
  ]), (error) => code(error) === "DUPLICATE_PATH");
});

test("bounds the number of edits and the total content bytes in one change set", async () => {
  const root = await fixture();
  const editor = new TransactionalRepositoryChangeSetEditor(new SafeRepositoryFileEditor(), { maxEdits: 2, maxChangeSetBytes: 16 });
  await assert.rejects(editor.preview(root, [
    { operation: "create", path: "src/a.ts", content: "a", mustNotExist: true },
    { operation: "create", path: "src/b.ts", content: "b", mustNotExist: true },
    { operation: "create", path: "src/c.ts", content: "c", mustNotExist: true },
  ]), (error) => code(error) === "CHANGE_SET_TOO_LARGE");
  await assert.rejects(editor.preview(root, [
    { operation: "create", path: "src/a.ts", content: "x".repeat(17), mustNotExist: true },
  ]), (error) => code(error) === "CHANGE_SET_TOO_LARGE");
  await assert.rejects(readFile(join(root, "src/a.ts")), { code: "ENOENT" });
});
