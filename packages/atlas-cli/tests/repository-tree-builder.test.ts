import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { RepositoryTreeBuilder } from "../src/infrastructure/repository-tree-builder.js";

test("builds a normalized bounded repository tree", async () => {
  const root = await mkdtemp(join(tmpdir(), "atlas-tree-"));
  try {
    await mkdir(join(root, "src", "domain"), { recursive: true });
    await writeFile(join(root, "README.md"), "readme\n");
    await writeFile(join(root, "src", "domain", "model.ts"), "export {};\n");
    const result = await new RepositoryTreeBuilder().build(root, 4, 20);
    assert.deepEqual(result.entries.map((entry) => [entry.path, entry.kind]), [
      ["README.md", "file"], ["src", "directory"], ["src/domain", "directory"], ["src/domain/model.ts", "file"],
    ]);
    assert.equal(result.truncated, false);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
