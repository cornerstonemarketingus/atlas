import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { RepositorySourceReadError } from "../src/domain/repository-source.js";
import { BoundedRepositorySourceReader } from "../src/infrastructure/bounded-repository-source-reader.js";

async function fixture(): Promise<string> {
  return mkdtemp(join(tmpdir(), "atlas-source-"));
}

test("reads a bounded line range and normalizes repository paths", async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src", "example.ts"), "one\r\ntwo\r\nthree\r\nfour\r\n", "utf8");

  const result = await new BoundedRepositorySourceReader().read(
    root,
    "src/example.ts",
    { startLine: 2, endLine: 3 },
  );

  assert.equal(result.path, "src/example.ts");
  assert.equal(result.content, "two\nthree");
  assert.equal(result.startLine, 2);
  assert.equal(result.endLine, 3);
  assert.equal(result.truncated, false);
});

test("rejects absolute paths and traversal outside the repository", async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const reader = new BoundedRepositorySourceReader();

  await assert.rejects(reader.read(root, join(root, "file.ts")), hasCode("ABSOLUTE_PATH_NOT_ALLOWED"));
  await assert.rejects(reader.read(root, "../outside.ts"), hasCode("PATH_OUTSIDE_REPOSITORY"));
});

test("reports byte and line truncation independently", async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "large.txt"), "alpha\nbeta\ngamma\ndelta", "utf8");
  const reader = new BoundedRepositorySourceReader();

  const byteLimited = await reader.read(root, "large.txt", { maxBytes: 10, maxLines: 20 });
  assert.equal(byteLimited.content, "alpha\nbeta");
  assert.equal(byteLimited.truncatedByBytes, true);

  const lineLimited = await reader.read(root, "large.txt", { maxBytes: 100, maxLines: 2 });
  assert.equal(lineLimited.content, "alpha\nbeta");
  assert.equal(lineLimited.truncatedByBytes, false);
  assert.equal(lineLimited.truncatedByLines, true);
});

test("rejects invalid ranges and limits", async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "file.txt"), "text", "utf8");
  const reader = new BoundedRepositorySourceReader();

  await assert.rejects(reader.read(root, "file.txt", { startLine: 0 }), hasCode("INVALID_LINE_RANGE"));
  await assert.rejects(
    reader.read(root, "file.txt", { startLine: 3, endLine: 2 }),
    hasCode("INVALID_LINE_RANGE"),
  );
  await assert.rejects(reader.read(root, "file.txt", { maxBytes: 0 }), hasCode("INVALID_LIMIT"));
});

test("rejects binary and invalid UTF-8 content", async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "binary.bin"), Buffer.from([65, 0, 66]));
  await writeFile(join(root, "encoded.txt"), Buffer.from([0xc3, 0x28]));
  const reader = new BoundedRepositorySourceReader();

  await assert.rejects(reader.read(root, "binary.bin"), hasCode("BINARY_FILE"));
  await assert.rejects(reader.read(root, "encoded.txt"), hasCode("UNSUPPORTED_ENCODING"));
});

test("accepts an incomplete UTF-8 boundary but not a malformed boundary", async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "valid.txt"), Buffer.from("abc€tail", "utf8"));
  await writeFile(join(root, "invalid.txt"), Buffer.from([0x61, 0xff, 0x62]));
  const reader = new BoundedRepositorySourceReader();

  const valid = await reader.read(root, "valid.txt", { maxBytes: 5 });
  assert.equal(valid.content, "abc");
  assert.equal(valid.truncatedByBytes, true);
  await assert.rejects(
    reader.read(root, "invalid.txt", { maxBytes: 2 }),
    hasCode("UNSUPPORTED_ENCODING"),
  );
});

test("rejects directories, missing paths, and symbolic links", async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "directory"));
  await writeFile(join(root, "target.txt"), "safe", "utf8");
  const reader = new BoundedRepositorySourceReader();

  await assert.rejects(reader.read(root, "directory"), hasCode("SOURCE_NOT_FILE"));
  await assert.rejects(reader.read(root, "missing.txt"), hasCode("PATH_UNREADABLE"));

  try {
    await symlink(join(root, "target.txt"), join(root, "link.txt"), "file");
    await assert.rejects(reader.read(root, "link.txt"), hasCode("SYMLINK_NOT_ALLOWED"));
  } catch (error) {
    if (!isWindowsSymlinkPermissionError(error)) throw error;
  }
});

function hasCode(code: RepositorySourceReadError["code"]): (error: unknown) => boolean {
  return (error) => error instanceof RepositorySourceReadError && error.code === code;
}

function isWindowsSymlinkPermissionError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EPERM";
}
