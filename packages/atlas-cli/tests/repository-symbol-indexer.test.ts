import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { RepositorySymbolIndexer } from "../src/infrastructure/repository-symbol-indexer.js";

test("indexes supported declarations and skips dependency directories", async () => {
  const root = await mkdtemp(join(tmpdir(), "atlas-symbols-"));
  try {
    await mkdir(join(root, "src"));
    await mkdir(join(root, "node_modules"));
    await writeFile(join(root, "src", "service.ts"), [
      "export interface Service {}",
      "export type ServiceId = string;",
      "export async function createService() {}",
      "export class ServiceRegistry {}",
      "",
    ].join("\n"));
    await writeFile(join(root, "worker.py"), "def run_worker():\n    pass\n");
    await writeFile(join(root, "node_modules", "ignored.ts"), "export class Ignored {}\n");

    const result = await new RepositorySymbolIndexer().index(root);

    assert.deepEqual(result.symbols.map(({ name, kind, language }) => ({ name, kind, language })), [
      { name: "Service", kind: "interface", language: "typescript" },
      { name: "ServiceId", kind: "type", language: "typescript" },
      { name: "createService", kind: "function", language: "typescript" },
      { name: "ServiceRegistry", kind: "class", language: "typescript" },
      { name: "run_worker", kind: "function", language: "python" },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("filters symbols and reports truncation", async () => {
  const root = await mkdtemp(join(tmpdir(), "atlas-symbol-limit-"));
  try {
    await writeFile(join(root, "symbols.ts"), "class AtlasOne {}\nclass AtlasTwo {}\nclass Other {}\n");
    const result = await new RepositorySymbolIndexer().index(root, {
      query: "atlas",
      maxSymbols: 1,
    });

    assert.equal(result.symbols[0]?.name, "AtlasOne");
    assert.equal(result.warnings[0]?.code, "SYMBOL_LIMIT_REACHED");
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
