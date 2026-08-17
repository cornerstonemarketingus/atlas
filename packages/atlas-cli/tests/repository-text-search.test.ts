import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { RepositoryTextSearch } from "../src/infrastructure/repository-text-search.js";

test("finds literal file and content matches while skipping binary and dependencies", async () => {
  const root = await mkdtemp(join(tmpdir(), "atlas-search-"));
  try {
    await mkdir(join(root, "src"));
    await mkdir(join(root, "node_modules"));
    await writeFile(join(root, "src", "atlas-service.ts"), "export const greeting = 'Hello Atlas';\n");
    await writeFile(join(root, "src", "binary.bin"), Buffer.from([0, 65, 116, 108, 97, 115]));
    await writeFile(join(root, "node_modules", "ignored.ts"), "Atlas\n");

    const result = await new RepositoryTextSearch().search(root, "atlas");

    assert.deepEqual(result.matches, [
      { kind: "file", path: join("src", "atlas-service.ts") },
      {
        kind: "content",
        path: join("src", "atlas-service.ts"),
        line: 1,
        column: 32,
        preview: "export const greeting = 'Hello Atlas';",
      },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("reports result truncation", async () => {
  const root = await mkdtemp(join(tmpdir(), "atlas-search-limit-"));
  try {
    await writeFile(join(root, "matches.txt"), "Atlas\nAtlas\n");
    const result = await new RepositoryTextSearch().search(root, "Atlas", {
      scope: "content",
      maxResults: 1,
    });

    assert.equal(result.matches.length, 1);
    assert.equal(result.warnings[0]?.code, "RESULT_LIMIT_REACHED");
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
