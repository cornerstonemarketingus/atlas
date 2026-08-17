import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { RepositoryFileEditError } from "../src/domain/repository-file-edit.js";
import { SafeRepositoryFileEditor } from "../src/infrastructure/safe-repository-file-editor.js";

const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "atlas-edit-"));
  await mkdir(join(root, "src"));
  return root;
}
function code(error: unknown): string | undefined {
  return error instanceof RepositoryFileEditError ? error.code : undefined;
}

test("previews without mutation then applies an approved create", async () => {
  const root = await fixture();
  const editor = new SafeRepositoryFileEditor();
  const plan = await editor.preview(root, { operation: "create", path: "src/new.ts", content: "export const n = 1;\n", mustNotExist: true });
  await assert.rejects(readFile(join(root, "src/new.ts")), { code: "ENOENT" });
  assert.equal(plan.beforeSha256, null);
  assert.match(plan.diff, /^--- \/dev\/null\n\+\+\+ b\/src\/new\.ts/m);
  const result = await editor.apply(plan, { approved: true, planDigest: plan.planDigest });
  assert.equal(await readFile(join(root, "src/new.ts"), "utf8"), "export const n = 1;\n");
  assert.equal(result.afterSha256, hash("export const n = 1;\n"));
});

test("updates text and preserves CRLF newline style", async () => {
  const root = await fixture();
  const path = join(root, "src/existing.ts");
  await writeFile(path, "one\r\ntwo\r\n");
  const editor = new SafeRepositoryFileEditor();
  const plan = await editor.preview(root, { operation: "update", path: "src/existing.ts", content: "three\nfour\n", expectedSha256: hash("one\r\ntwo\r\n") });
  await editor.apply(plan, { approved: true, planDigest: plan.planDigest });
  assert.equal(await readFile(path, "utf8"), "three\r\nfour\r\n");
});

test("rejects stale updates during preview and immediately before apply", async () => {
  const root = await fixture();
  const path = join(root, "src/file.ts");
  await writeFile(path, "before\n");
  const editor = new SafeRepositoryFileEditor();
  await assert.rejects(editor.preview(root, { operation: "update", path: "src/file.ts", content: "after\n", expectedSha256: hash("wrong") }), (error) => code(error) === "STALE_FILE");
  const plan = await editor.preview(root, { operation: "update", path: "src/file.ts", content: "after\n", expectedSha256: hash("before\n") });
  await writeFile(path, "raced\n");
  await assert.rejects(editor.apply(plan, { approved: true, planDigest: plan.planDigest }), (error) => code(error) === "STALE_FILE");
  assert.equal(await readFile(path, "utf8"), "raced\n");
});

test("rejects tampered approvals and plans", async () => {
  const root = await fixture();
  const editor = new SafeRepositoryFileEditor();
  const plan = await editor.preview(root, { operation: "create", path: "src/new.ts", content: "safe\n", mustNotExist: true });
  await assert.rejects(editor.apply(plan, { approved: true, planDigest: "0".repeat(64) }), (error) => code(error) === "APPROVAL_MISMATCH");
  await assert.rejects(editor.apply({ ...plan, path: "src/other.ts" }, { approved: true, planDigest: plan.planDigest }), (error) => code(error) === "APPROVAL_MISMATCH");
});

test("rejects absolute paths and traversal", async () => {
  const root = await fixture();
  const editor = new SafeRepositoryFileEditor();
  await assert.rejects(editor.preview(root, { operation: "create", path: join(root, "x.ts"), content: "x", mustNotExist: true }), (error) => code(error) === "ABSOLUTE_PATH_NOT_ALLOWED");
  await assert.rejects(editor.preview(root, { operation: "create", path: "../x.ts", content: "x", mustNotExist: true }), (error) => code(error) === "PATH_OUTSIDE_REPOSITORY");
});

test("rejects symlink traversal when supported", async (t) => {
  const root = await fixture();
  const outside = await fixture();
  try { await symlink(outside, join(root, "linked"), "junction"); } catch { t.skip("Symlink creation is unavailable"); return; }
  const editor = new SafeRepositoryFileEditor();
  await assert.rejects(editor.preview(root, { operation: "create", path: "linked/x.ts", content: "x", mustNotExist: true }), (error) => code(error) === "SYMLINK_NOT_ALLOWED");
});

test("rejects oversized and binary content", async () => {
  const root = await fixture();
  const editor = new SafeRepositoryFileEditor({ maxFileBytes: 8 });
  await assert.rejects(editor.preview(root, { operation: "create", path: "src/large.ts", content: "123456789", mustNotExist: true }), (error) => code(error) === "CHANGE_TOO_LARGE");
  await assert.rejects(editor.preview(root, { operation: "create", path: "src/binary.ts", content: "a\0b", mustNotExist: true }), (error) => code(error) === "INVALID_TEXT");
  await writeFile(join(root, "src/existing.bin"), Buffer.from([1, 0, 2]));
  await assert.rejects(editor.preview(root, { operation: "update", path: "src/existing.bin", content: "text", expectedSha256: "irrelevant" }), (error) => code(error) === "INVALID_TEXT");
});

test("bounds deterministic diff output", async () => {
  const root = await fixture();
  const editor = new SafeRepositoryFileEditor({ maxDiffBytes: 100, maxFileBytes: 1000 });
  const request = { operation: "create", path: "src/new.ts", content: "line\n".repeat(30), mustNotExist: true } as const;
  const first = await editor.preview(root, request);
  const second = await editor.preview(root, request);
  assert.equal(first.diff, second.diff);
  assert.equal(first.diffTruncated, true);
  assert.ok(Buffer.byteLength(first.diff) <= 100);
});

test("bounds and explicitly discards pending edit content", async () => {
  const root = await fixture();
  const editor = new SafeRepositoryFileEditor({ maxPendingPlans: 1 });
  const first = await editor.preview(root, {
    operation: "create", path: "src/one.ts", content: "one\n", mustNotExist: true,
  });
  await assert.rejects(editor.preview(root, {
    operation: "create", path: "src/two.ts", content: "two\n", mustNotExist: true,
  }), (error) => code(error) === "PLAN_CAPACITY_REACHED");
  assert.equal(editor.discard(first.planDigest), true);
  assert.equal(editor.discard(first.planDigest), false);
  await editor.preview(root, {
    operation: "create", path: "src/two.ts", content: "two\n", mustNotExist: true,
  });
});
