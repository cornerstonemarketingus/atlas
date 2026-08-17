import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { RepositorySymbolReferenceFinder } from "../src/infrastructure/repository-symbol-reference-finder.js";

async function withRepository(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "atlas-references-"));
  try { await run(root); } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

test("finds declarations and references across supported languages", async () => {
  await withRepository(async (root) => {
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "service.ts"), "export class AtlasService {}\nconst service: AtlasService = new AtlasService();\n");
    await writeFile(join(root, "worker.py"), "class AtlasService:\n    pass\nvalue = AtlasService()\n");

    const result = await new RepositorySymbolReferenceFinder().find(root, "AtlasService");

    assert.deepEqual(result.occurrences.map(({ classification, path, line, column, language }) => ({ classification, path, line, column, language })), [
      { classification: "declaration", path: join("src", "service.ts"), line: 1, column: 14, language: "typescript" },
      { classification: "reference", path: join("src", "service.ts"), line: 2, column: 16, language: "typescript" },
      { classification: "reference", path: join("src", "service.ts"), line: 2, column: 35, language: "typescript" },
      { classification: "declaration", path: "worker.py", line: 1, column: 7, language: "python" },
      { classification: "reference", path: "worker.py", line: 3, column: 9, language: "python" },
    ]);
    assert.equal(result.filesScanned, 2);
    assert.ok(result.bytesScanned > 0);
  });
});

test("matches identifiers exactly and validates queries", async () => {
  await withRepository(async (root) => {
    await writeFile(join(root, "names.js"), "function Atlas() {}\nAtlas();\nAtlasOther();\n");
    const finder = new RepositorySymbolReferenceFinder();
    const result = await finder.find(root, "Atlas");
    assert.equal(result.occurrences.length, 2);
    await assert.rejects(finder.find(root, "Atlas Service"), /valid identifier/u);
  });
});

test("reports result, file-size, and total-byte truncation", async () => {
  await withRepository(async (root) => {
    await writeFile(join(root, "a.ts"), "Atlas(); Atlas(); Atlas();\n");
    await writeFile(join(root, "large.ts"), "Atlas();".repeat(20));
    const finder = new RepositorySymbolReferenceFinder();
    const resultLimited = await finder.find(root, "Atlas", { maxResults: 2 });
    assert.equal(resultLimited.occurrences.length, 2);
    assert.ok(resultLimited.warnings.some(({ code }) => code === "RESULT_LIMIT_REACHED"));

    const fileLimited = await finder.find(root, "Atlas", { maxFileBytes: 30 });
    assert.ok(fileLimited.warnings.some(({ code }) => code === "FILE_TOO_LARGE"));

    const byteLimited = await finder.find(root, "Atlas", { maxTotalBytes: 5 });
    assert.equal(byteLimited.filesScanned, 0);
    assert.ok(byteLimited.warnings.some(({ code }) => code === "TOTAL_BYTE_LIMIT_REACHED"));
  });
});

test("skips binary and dependency-directory content", async () => {
  await withRepository(async (root) => {
    await mkdir(join(root, "node_modules"));
    await writeFile(join(root, "node_modules", "ignored.ts"), "class Atlas {}\n");
    await writeFile(join(root, "binary.ts"), Buffer.from([65, 116, 108, 97, 115, 0, 65]));
    const result = await new RepositorySymbolReferenceFinder().find(root, "Atlas");
    assert.equal(result.occurrences.length, 0);
    assert.equal(result.filesScanned, 0);
  });
});
