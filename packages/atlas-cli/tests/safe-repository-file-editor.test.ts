import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, mkdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
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

const posixModes = process.platform !== "win32";

test("an update keeps the file's permission bits; a new file gets the default mode", { skip: !posixModes && "POSIX modes only" }, async () => {
  const root = await fixture();
  const script = join(root, "src/run.sh");
  await writeFile(script, "#!/bin/sh\necho old\n");
  await chmod(script, 0o755);
  await writeFile(join(root, "src/reference.txt"), "x");
  const editor = new SafeRepositoryFileEditor();
  const update = await editor.preview(root, { operation: "update", path: "src/run.sh", content: "#!/bin/sh\necho new\n", expectedSha256: hash("#!/bin/sh\necho old\n") });
  await editor.apply(update, { approved: true, planDigest: update.planDigest });
  assert.equal((await stat(script)).mode & 0o7777, 0o755, "an executable script stays executable");
  const create = await editor.preview(root, { operation: "create", path: "src/new.txt", content: "n\n", mustNotExist: true });
  await editor.apply(create, { approved: true, planDigest: create.planDigest });
  assert.equal((await stat(join(root, "src/new.txt"))).mode & 0o777, (await stat(join(root, "src/reference.txt"))).mode & 0o777, "same mode as any file the user creates (umask applies), not 0600");
});

test("an update keeps a UTF-8 byte-order mark; hashes stay over the text without it", async () => {
  const root = await fixture();
  const path = join(root, "src/bom.cs");
  await writeFile(path, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("class A {}\r\n")]));
  const editor = new SafeRepositoryFileEditor();
  const plan = await editor.preview(root, { operation: "update", path: "src/bom.cs", content: "class B {}\n", expectedSha256: hash("class A {}\r\n") });
  const result = await editor.apply(plan, { approved: true, planDigest: plan.planDigest });
  const bytes = await readFile(path);
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], "the mark is written back");
  assert.equal(bytes.subarray(3).toString("utf8"), "class B {}\r\n", "and CRLF is kept as before");
  assert.equal(result.afterSha256, hash("class B {}\r\n"));
  const next = await editor.preview(root, { operation: "update", path: "src/bom.cs", content: "class C {}\n", expectedSha256: hash("class B {}\r\n") });
  assert.equal(next.beforeSha256, hash("class B {}\r\n"), "a follow-up edit sees the same hash the result reported");
});
