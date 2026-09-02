import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { PolicyEnforcedReadOnlyToolRegistry } from "../src/infrastructure/policy-enforced-read-only-tool-registry.js";
import { SafeRepositoryFileEditor } from "../src/infrastructure/safe-repository-file-editor.js";
import { FilesystemRepositoryInspector } from "../src/infrastructure/filesystem-repository-inspector.js";
import { RepositoryTextSearch } from "../src/infrastructure/repository-text-search.js";
import { RepositorySymbolIndexer } from "../src/infrastructure/repository-symbol-indexer.js";
import { RepositorySymbolReferenceFinder } from "../src/infrastructure/repository-symbol-reference-finder.js";
import { BoundedRepositorySourceReader } from "../src/infrastructure/bounded-repository-source-reader.js";
import {
  createRepositoryReadOnlyTools,
  registerRepositoryReadOnlyTools,
} from "../src/infrastructure/repository-read-only-tools.js";
import {
  createRepositoryWriteTools,
  registerRepositoryWriteTools,
} from "../src/infrastructure/repository-write-tools.js";
import {
  REPOSITORY_READ_ONLY_MODEL_TOOLS,
  REPOSITORY_WRITE_MODEL_TOOLS,
} from "../src/model/repository-tool-model-definitions.js";

/**
 * The model is handed one list of tool definitions and calls into a separate
 * registry. Nothing in the type system ties the two together, and a mismatch
 * only shows up in production: an advertised tool that is not registered
 * raises TOOL_NOT_FOUND, which ends the session rather than failing softly, and
 * a registered tool that is not advertised is simply unreachable work.
 *
 * This has already happened once — repository.propose_change_set was advertised
 * to the model while cli.ts registered only the single-file editor — so it is
 * pinned here rather than left to review.
 */
test("every tool advertised to the model is registered, and vice versa", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atlas-tool-parity-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const registry = new PolicyEnforcedReadOnlyToolRegistry({ policy: { defaultDecision: "allow", rules: [] } });
  const binding = { repositoryId: "atlas", repositoryRoot: root };
  registerRepositoryReadOnlyTools(registry, createRepositoryReadOnlyTools(binding, {
    inspector: new FilesystemRepositoryInspector(),
    searcher: new RepositoryTextSearch(),
    symbolIndexer: new RepositorySymbolIndexer(),
    referenceFinder: new RepositorySymbolReferenceFinder(),
    sourceReader: new BoundedRepositorySourceReader(),
  }));
  registerRepositoryWriteTools(registry, createRepositoryWriteTools(binding, { editor: new SafeRepositoryFileEditor() }));

  const advertised = [...REPOSITORY_READ_ONLY_MODEL_TOOLS, ...REPOSITORY_WRITE_MODEL_TOOLS]
    .map((tool) => tool.name)
    .sort();
  const registered = registry.list().map((tool) => tool.name).sort();

  assert.deepEqual(registered, advertised);
});

test("advertises no duplicate tool names to the model", () => {
  // Two definitions sharing a name means one of them can never be called, and
  // the registry would reject the second registration outright.
  const names = [...REPOSITORY_READ_ONLY_MODEL_TOOLS, ...REPOSITORY_WRITE_MODEL_TOOLS].map((tool) => tool.name);
  assert.equal(new Set(names).size, names.length);
});
