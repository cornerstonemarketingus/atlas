import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import test from "node:test";
import { RepositoryFileEnumerator } from "../src/infrastructure/repository-file-enumerator.js";

test("enumerates bounded files while skipping dependency directories", async () => {
  const root = await mkdtemp(join(tmpdir(), "atlas-enumerator-"));
  try {
    await mkdir(join(root, "src"));
    await mkdir(join(root, "node_modules"));
    await writeFile(join(root, "src", "one.ts"), "export const one = 1;\n");
    await writeFile(join(root, "src", "two.py"), "two = 2\n");
    await writeFile(join(root, "node_modules", "ignored.ts"), "ignored\n");

    const result = await new RepositoryFileEnumerator().enumerate(root, {
      maxFiles: 10,
      maxDepth: 5,
    });

    assert.deepEqual(result.files.map((file) => file.relativePath).sort(), [
      join("src", "one.ts"),
      join("src", "two.py"),
    ]);
    assert.equal(result.limitReached, false);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("applies inclusion filters before the file limit", async () => {
  const root = await mkdtemp(join(tmpdir(), "atlas-enumerator-limit-"));
  try {
    await writeFile(join(root, "notes.txt"), "notes\n");
    await writeFile(join(root, "one.ts"), "one\n");
    await writeFile(join(root, "two.ts"), "two\n");

    const result = await new RepositoryFileEnumerator().enumerate(root, {
      maxFiles: 1,
      maxDepth: 1,
      include: (path) => extname(path) === ".ts",
    });

    assert.equal(result.files.length, 1);
    assert.equal(result.files[0]?.relativePath, "one.ts");
    assert.equal(result.limitReached, true);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
