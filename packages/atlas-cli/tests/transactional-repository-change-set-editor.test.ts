import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { RepositoryChangeSetError } from "../src/domain/repository-change-set.js";
import { SafeRepositoryFileEditor } from "../src/infrastructure/safe-repository-file-editor.js";
import { TransactionalRepositoryChangeSetEditor } from "../src/infrastructure/transactional-repository-change-set-editor.js";

const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "atlas-change-set-"));
  await mkdir(join(root, "src"));
  return root;
}
function code(error: unknown): string | undefined { return error instanceof RepositoryChangeSetError ? error.code : undefined; }

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
