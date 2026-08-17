import assert from "node:assert/strict";
import test from "node:test";
import type { RepositoryReadOnlyToolServices } from "../src/infrastructure/repository-read-only-tools.js";
import {
  createRepositoryReadOnlyTools,
  registerRepositoryReadOnlyTools,
  RepositoryToolInputError,
} from "../src/infrastructure/repository-read-only-tools.js";
import { PolicyEnforcedReadOnlyToolRegistry } from "../src/infrastructure/policy-enforced-read-only-tool-registry.js";

function createServices(calls: string[]): RepositoryReadOnlyToolServices {
  return {
    inspector: {
      inspect: async (root) => {
        calls.push(`inspect:${root}`);
        return {
          schemaVersion: 1, root, repositoryName: "repo",
          git: { isAvailable: true, isRepository: true, branch: "main", headCommit: "abc", isDirty: false },
          fileCount: 1, languages: [], manifests: [], frameworks: [], architecture: [],
          topLevelDirectories: [], warnings: [],
        };
      },
    },
    searcher: {
      search: async (root, query, options) => {
        calls.push(`search:${root}:${query}:${options?.scope}:${options?.maxResults}`);
        return { schemaVersion: 1, root, query, scope: options?.scope ?? "all", filesScanned: 1, matches: [], warnings: [] };
      },
    },
    symbolIndexer: {
      index: async (root, options) => {
        calls.push(`symbols:${root}:${options?.query}:${options?.maxSymbols}`);
        return { schemaVersion: 1, root, query: options?.query ?? null, filesScanned: 1, symbols: [], warnings: [] };
      },
    },
    referenceFinder: {
      find: async (root, name, options) => {
        calls.push(`references:${root}:${name}:${options?.maxResults}`);
        return { schemaVersion: 1, root, query: name, filesScanned: 1, bytesScanned: 10, occurrences: [], warnings: [] };
      },
    },
    sourceReader: {
      read: async (root, path, options) => {
        calls.push(`read:${root}:${path}:${options?.startLine}:${options?.endLine}:${options?.maxLines}:${options?.maxBytes}`);
        return {
          schemaVersion: 1, root, path, content: "source", startLine: options?.startLine ?? 1,
          endLine: options?.endLine ?? 1, bytesRead: 6, truncated: false,
          truncatedByBytes: false, truncatedByLines: false,
        };
      },
    },
  };
}

test("delegates every adapter to its fixed repository root", async () => {
  const calls: string[] = [];
  const tools = createRepositoryReadOnlyTools(
    { repositoryId: "atlas", repositoryRoot: "C:\\repos\\atlas" },
    createServices(calls),
  );
  const context = { repositoryId: "atlas" };

  await tools.inspect.execute(tools.inspect.validateInput({}), context);
  await tools.search.execute(tools.search.validateInput({ query: "Agent", scope: "content", maxResults: 5 }), context);
  await tools.symbols.execute(tools.symbols.validateInput({ query: "Agent", maxResults: 6 }), context);
  await tools.references.execute(tools.references.validateInput({ symbolName: "Agent", maxResults: 7 }), context);
  await tools.readSource.execute(tools.readSource.validateInput({ path: "src/a.ts", startLine: 2, endLine: 4, maxLines: 3, maxBytes: 100 }), context);

  assert.deepEqual(calls, [
    "inspect:C:\\repos\\atlas",
    "search:C:\\repos\\atlas:Agent:content:5",
    "symbols:C:\\repos\\atlas:Agent:6",
    "references:C:\\repos\\atlas:Agent:7",
    "read:C:\\repos\\atlas:src/a.ts:2:4:3:100",
  ]);
});

test("rejects malformed, excessive, and unknown model-controlled inputs", () => {
  const tools = createRepositoryReadOnlyTools(
    { repositoryId: "atlas", repositoryRoot: "C:\\repos\\atlas" },
    createServices([]),
  );

  assert.throws(() => tools.inspect.validateInput({ root: "C:\\other" }), RepositoryToolInputError);
  assert.throws(() => tools.search.validateInput({ query: "" }), RepositoryToolInputError);
  assert.throws(() => tools.search.validateInput({ query: "x", scope: "everywhere" }), RepositoryToolInputError);
  assert.throws(() => tools.symbols.validateInput({ maxResults: 1_001 }), RepositoryToolInputError);
  assert.throws(() => tools.references.validateInput({ symbolName: 42 }), RepositoryToolInputError);
  assert.throws(() => tools.readSource.validateInput({ path: "a.ts", startLine: 4, endLine: 3 }), RepositoryToolInputError);
  assert.throws(() => tools.readSource.validateInput({ path: "a.ts", maxBytes: 4_194_305 }), RepositoryToolInputError);
});

test("enforces repository binding even with a globally scoped registry request", async () => {
  const calls: string[] = [];
  const tools = createRepositoryReadOnlyTools(
    { repositoryId: "atlas", repositoryRoot: "C:\\repos\\atlas" },
    createServices(calls),
  );
  const registry = new PolicyEnforcedReadOnlyToolRegistry({
    policy: { defaultDecision: "allow", rules: [] },
  });
  registerRepositoryReadOnlyTools(registry, tools);

  await assert.rejects(
    registry.execute({
      name: "repository.inspect",
      input: {},
      scope: { kind: "global" },
      context: { repositoryId: "other" },
    }),
    /bound to repository atlas/u,
  );
  assert.deepEqual(calls, []);

  const result = await registry.execute({
    name: "repository.inspect",
    input: {},
    scope: { kind: "repository", repositoryId: "atlas" },
    context: { repositoryId: "atlas" },
  });
  assert.equal(result.status, "completed");
  assert.deepEqual(registry.list().map((tool) => [tool.name, tool.risk]), [
    ["repository.inspect", "low"],
    ["repository.read_source", "moderate"],
    ["repository.references", "low"],
    ["repository.search", "moderate"],
    ["repository.symbols", "low"],
  ]);
});
