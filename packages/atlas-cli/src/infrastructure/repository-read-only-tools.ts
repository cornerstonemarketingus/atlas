import type {
  ReadOnlyToolContext,
  ReadOnlyToolDefinition,
  ReadOnlyToolRegistry,
} from "../domain/read-only-tool-registry.js";
import type { RepositoryInspector } from "../domain/repository-inspector.js";
import type {
  RepositorySearcher,
  RepositorySearchResult,
  SearchScope,
} from "../domain/repository-search.js";
import type {
  RepositorySourceReader,
  RepositorySourceReadResult,
} from "../domain/repository-source.js";
import type {
  RepositorySymbolReferenceFinder,
  RepositorySymbolReferenceResult,
} from "../domain/repository-symbol-reference.js";
import type {
  RepositorySymbolIndexer,
  RepositorySymbolResult,
} from "../domain/repository-symbol.js";
import type { RepositorySummary } from "../domain/repository-summary.js";
import { testsFor, type ImportGraph, type TestsForResult } from "./repository-import-graph.js";

const MAX_QUERY_LENGTH = 1_000;
const MAX_PATH_LENGTH = 4_096;
const MAX_RESULTS = 1_000;
const MAX_READ_LINES = 10_000;
const MAX_READ_BYTES = 4 * 1024 * 1024;

export class RepositoryToolInputError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "RepositoryToolInputError";
  }
}

export interface RepositoryToolBinding {
  readonly repositoryId: string;
  readonly repositoryRoot: string;
}

export interface RepositoryReadOnlyToolServices {
  readonly inspector: RepositoryInspector;
  readonly searcher: RepositorySearcher;
  readonly symbolIndexer: RepositorySymbolIndexer;
  readonly referenceFinder: RepositorySymbolReferenceFinder;
  readonly sourceReader: RepositorySourceReader;
  /** Optional: when present, repository.tests_for is offered. */
  readonly importGraph?: { build(repositoryRoot: string): Promise<ImportGraph> };
}

export interface InspectRepositoryInput {}

export interface SearchRepositoryInput {
  readonly query: string;
  readonly scope?: SearchScope;
  readonly maxResults?: number;
}

export interface IndexRepositorySymbolsInput {
  readonly query?: string;
  readonly maxResults?: number;
}

export interface FindRepositoryReferencesInput {
  readonly symbolName: string;
  readonly maxResults?: number;
}

export interface FindTestsForInput {
  readonly path: string;
  readonly depth?: number;
}

export interface TestsForToolResult extends TestsForResult {
  /** False when the path is not a TypeScript, JavaScript or Python source file in the repository. */
  readonly known: boolean;
  readonly truncated: boolean;
}

const MAX_TESTS_REPORTED = 50;

export interface ReadRepositorySourceInput {
  readonly path: string;
  readonly startLine?: number;
  readonly endLine?: number;
  readonly maxLines?: number;
  readonly maxBytes?: number;
}

export interface RepositoryReadOnlyTools {
  readonly inspect: ReadOnlyToolDefinition<InspectRepositoryInput, RepositorySummary>;
  readonly search: ReadOnlyToolDefinition<SearchRepositoryInput, RepositorySearchResult>;
  readonly symbols: ReadOnlyToolDefinition<IndexRepositorySymbolsInput, RepositorySymbolResult>;
  readonly references: ReadOnlyToolDefinition<FindRepositoryReferencesInput, RepositorySymbolReferenceResult>;
  readonly readSource: ReadOnlyToolDefinition<ReadRepositorySourceInput, RepositorySourceReadResult>;
  readonly testsFor?: ReadOnlyToolDefinition<FindTestsForInput, TestsForToolResult>;
}

/**
 * Creates read-only tools permanently bound to one repository. Repository roots
 * are deliberately absent from model-controlled inputs.
 */
export function createRepositoryReadOnlyTools(
  binding: RepositoryToolBinding,
  services: RepositoryReadOnlyToolServices,
): RepositoryReadOnlyTools {
  if (binding.repositoryId.trim().length === 0 || binding.repositoryRoot.trim().length === 0) {
    throw new Error("Repository tool bindings require a repository ID and root.");
  }

  return {
    inspect: {
      name: "repository.inspect",
      description: "Inspect bounded repository metadata without reading source content.",
      risk: "low",
      validateInput: validateEmptyObject,
      execute: async (_input, context) => {
        assertRepositoryBinding(binding, context);
        return services.inspector.inspect(binding.repositoryRoot);
      },
    },
    search: {
      name: "repository.search",
      description: "Search repository paths and source previews; previews may contain sensitive text.",
      risk: "moderate",
      validateInput: validateSearchInput,
      execute: async (input, context) => {
        assertRepositoryBinding(binding, context);
        return services.searcher.search(binding.repositoryRoot, input.query, {
          ...(input.scope === undefined ? {} : { scope: input.scope }),
          ...(input.maxResults === undefined ? {} : { maxResults: input.maxResults }),
        });
      },
    },
    symbols: {
      name: "repository.symbols",
      description: "Index declarations from bounded repository source files.",
      risk: "low",
      validateInput: validateSymbolsInput,
      execute: async (input, context) => {
        assertRepositoryBinding(binding, context);
        return services.symbolIndexer.index(binding.repositoryRoot, {
          ...(input.query === undefined ? {} : { query: input.query }),
          ...(input.maxResults === undefined ? {} : { maxSymbols: input.maxResults }),
        });
      },
    },
    references: {
      name: "repository.references",
      description: "Find lexical symbol occurrences in bounded repository source files.",
      risk: "low",
      validateInput: validateReferencesInput,
      execute: async (input, context) => {
        assertRepositoryBinding(binding, context);
        return services.referenceFinder.find(binding.repositoryRoot, input.symbolName, {
          ...(input.maxResults === undefined ? {} : { maxResults: input.maxResults }),
        });
      },
    },
    readSource: {
      name: "repository.read_source",
      description: "Read a bounded source range; repository files may contain secrets or hostile text.",
      risk: "moderate",
      validateInput: validateReadSourceInput,
      execute: async (input, context) => {
        assertRepositoryBinding(binding, context);
        return services.sourceReader.read(binding.repositoryRoot, input.path, {
          ...(input.startLine === undefined ? {} : { startLine: input.startLine }),
          ...(input.endLine === undefined ? {} : { endLine: input.endLine }),
          ...(input.maxLines === undefined ? {} : { maxLines: input.maxLines }),
          ...(input.maxBytes === undefined ? {} : { maxBytes: input.maxBytes }),
        });
      },
    },
    ...(services.importGraph === undefined ? {} : {
      testsFor: {
        name: "repository.tests_for",
        description: "Find the tests that exercise a source file through imports, each with the import chain as evidence.",
        risk: "low" as const,
        validateInput: validateTestsForInput,
        execute: async (input: FindTestsForInput, context: ReadOnlyToolContext) => {
          assertRepositoryBinding(binding, context);
          const graph = await services.importGraph!.build(binding.repositoryRoot);
          const result = testsFor(graph, input.path, input.depth ?? 4);
          return {
            ...result,
            tests: result.tests.slice(0, MAX_TESTS_REPORTED),
            known: graph.files.includes(result.path),
            truncated: result.tests.length > MAX_TESTS_REPORTED,
          };
        },
      },
    }),
  };
}

export function registerRepositoryReadOnlyTools(
  registry: ReadOnlyToolRegistry,
  tools: RepositoryReadOnlyTools,
): void {
  registry.register(tools.inspect);
  registry.register(tools.search);
  registry.register(tools.symbols);
  registry.register(tools.references);
  registry.register(tools.readSource);
  if (tools.testsFor !== undefined) registry.register(tools.testsFor);
}

function assertRepositoryBinding(binding: RepositoryToolBinding, context: ReadOnlyToolContext): void {
  if (context.repositoryId !== binding.repositoryId) {
    throw new Error(`Repository tool is bound to repository ${binding.repositoryId}.`);
  }
}

function validateEmptyObject(input: unknown): InspectRepositoryInput {
  const object = validateObject(input, []);
  return object;
}

function validateSearchInput(input: unknown): SearchRepositoryInput {
  const object = validateObject(input, ["query", "scope", "maxResults"]);
  const query = validateRequiredString(object, "query", MAX_QUERY_LENGTH);
  const scope = object["scope"];
  if (scope !== undefined && scope !== "all" && scope !== "content" && scope !== "files") {
    throw new RepositoryToolInputError("scope must be all, content, or files.");
  }
  const maxResults = validateOptionalInteger(object, "maxResults", MAX_RESULTS);
  return { query, ...(scope === undefined ? {} : { scope }), ...(maxResults === undefined ? {} : { maxResults }) };
}

function validateSymbolsInput(input: unknown): IndexRepositorySymbolsInput {
  const object = validateObject(input, ["query", "maxResults"]);
  const query = validateOptionalString(object, "query", MAX_QUERY_LENGTH);
  const maxResults = validateOptionalInteger(object, "maxResults", MAX_RESULTS);
  return { ...(query === undefined ? {} : { query }), ...(maxResults === undefined ? {} : { maxResults }) };
}

function validateReferencesInput(input: unknown): FindRepositoryReferencesInput {
  const object = validateObject(input, ["symbolName", "maxResults"]);
  const symbolName = validateRequiredString(object, "symbolName", MAX_QUERY_LENGTH);
  const maxResults = validateOptionalInteger(object, "maxResults", MAX_RESULTS);
  return { symbolName, ...(maxResults === undefined ? {} : { maxResults }) };
}

function validateTestsForInput(input: unknown): FindTestsForInput {
  const object = validateObject(input, ["path", "depth"]);
  const path = validateRequiredString(object, "path", MAX_PATH_LENGTH);
  const depth = validateOptionalInteger(object, "depth", 10);
  return { path, ...(depth === undefined ? {} : { depth }) };
}

function validateReadSourceInput(input: unknown): ReadRepositorySourceInput {
  const object = validateObject(input, ["path", "startLine", "endLine", "maxLines", "maxBytes"]);
  const path = validateRequiredString(object, "path", MAX_PATH_LENGTH);
  const startLine = validateOptionalInteger(object, "startLine", Number.MAX_SAFE_INTEGER);
  const endLine = validateOptionalInteger(object, "endLine", Number.MAX_SAFE_INTEGER);
  const maxLines = validateOptionalInteger(object, "maxLines", MAX_READ_LINES);
  const maxBytes = validateOptionalInteger(object, "maxBytes", MAX_READ_BYTES);
  if (startLine !== undefined && endLine !== undefined && endLine < startLine) {
    throw new RepositoryToolInputError("endLine must be greater than or equal to startLine.");
  }
  return {
    path,
    ...(startLine === undefined ? {} : { startLine }),
    ...(endLine === undefined ? {} : { endLine }),
    ...(maxLines === undefined ? {} : { maxLines }),
    ...(maxBytes === undefined ? {} : { maxBytes }),
  };
}

function validateObject(input: unknown, allowedKeys: readonly string[]): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new RepositoryToolInputError("Tool input must be an object.");
  }
  const object = input as Record<string, unknown>;
  const unknownKey = Object.keys(object).find((key) => !allowedKeys.includes(key));
  if (unknownKey !== undefined) {
    throw new RepositoryToolInputError(`Unknown tool input field: ${unknownKey}`);
  }
  return object;
}

function validateRequiredString(
  object: Record<string, unknown>,
  key: string,
  maxLength: number,
): string {
  const value = object[key];
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maxLength) {
    throw new RepositoryToolInputError(`${key} must be a non-empty string of at most ${maxLength} characters.`);
  }
  return value;
}

function validateOptionalString(
  object: Record<string, unknown>,
  key: string,
  maxLength: number,
): string | undefined {
  return object[key] === undefined ? undefined : validateRequiredString(object, key, maxLength);
}

function validateOptionalInteger(
  object: Record<string, unknown>,
  key: string,
  maximum: number,
): number | undefined {
  const value = object[key];
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum) {
    throw new RepositoryToolInputError(`${key} must be an integer from 1 through ${maximum}.`);
  }
  return value as number;
}
