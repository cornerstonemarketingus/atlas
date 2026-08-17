import { extname } from "node:path";
import type {
  RepositorySymbol,
  RepositorySymbolIndexer as RepositorySymbolIndexerContract,
  RepositorySymbolKind,
  RepositorySymbolOptions,
  RepositorySymbolResult,
  RepositorySymbolWarning,
} from "../domain/repository-symbol.js";
import { GitClient } from "./git-client.js";
import { RepositoryFileEnumerator } from "./repository-file-enumerator.js";
import {
  nodeRepositoryFileSystem,
  type RepositoryFileSystem,
} from "./repository-file-system.js";

const DEFAULTS = {
  maxFiles: 20_000,
  maxSymbols: 1_000,
  maxFileBytes: 1024 * 1024,
  maxDepth: 25,
};

interface LanguageDefinition {
  readonly language: RepositorySymbol["language"];
  readonly patterns: readonly {
    readonly kind: RepositorySymbolKind;
    readonly expression: RegExp;
  }[];
}

const JAVASCRIPT_PATTERNS = [
  { kind: "function", expression: /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/u },
  { kind: "class", expression: /^\s*(?:export\s+)?(?:default\s+)?class\s+([A-Za-z_$][\w$]*)/u },
] as const;

const LANGUAGE_BY_EXTENSION: Readonly<Record<string, LanguageDefinition>> = {
  ".js": { language: "javascript", patterns: JAVASCRIPT_PATTERNS },
  ".jsx": { language: "javascript", patterns: JAVASCRIPT_PATTERNS },
  ".mjs": { language: "javascript", patterns: JAVASCRIPT_PATTERNS },
  ".cjs": { language: "javascript", patterns: JAVASCRIPT_PATTERNS },
  ".ts": {
    language: "typescript",
    patterns: [
      ...JAVASCRIPT_PATTERNS,
      { kind: "interface", expression: /^\s*(?:export\s+)?(?:default\s+)?interface\s+([A-Za-z_$][\w$]*)/u },
      { kind: "type", expression: /^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)/u },
      { kind: "enum", expression: /^\s*(?:export\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)/u },
    ],
  },
  ".tsx": {
    language: "typescript",
    patterns: [
      ...JAVASCRIPT_PATTERNS,
      { kind: "interface", expression: /^\s*(?:export\s+)?(?:default\s+)?interface\s+([A-Za-z_$][\w$]*)/u },
      { kind: "type", expression: /^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)/u },
      { kind: "enum", expression: /^\s*(?:export\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)/u },
    ],
  },
  ".py": {
    language: "python",
    patterns: [
      { kind: "function", expression: /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/u },
      { kind: "class", expression: /^\s*class\s+([A-Za-z_]\w*)\b/u },
    ],
  },
};

export class RepositorySymbolIndexer implements RepositorySymbolIndexerContract {
  public constructor(
    private readonly gitClient: GitClient = new GitClient(),
    private readonly fileSystem: RepositoryFileSystem = nodeRepositoryFileSystem,
  ) {}

  public async index(
    repositoryPath: string,
    options: RepositorySymbolOptions = {},
  ): Promise<RepositorySymbolResult> {
    const query = options.query?.trim() || null;
    if (query !== null && query.length > 200) {
      throw new Error("Symbol query must contain at most 200 characters.");
    }
    const limits = { ...DEFAULTS, ...options };
    if (limits.maxFiles < 1 || limits.maxSymbols < 1 || limits.maxFileBytes < 1 || limits.maxDepth < 0) {
      throw new Error("Symbol limits must be positive; maxDepth may be zero.");
    }
    const warnings: RepositorySymbolWarning[] = [];
    const enumeration = await new RepositoryFileEnumerator(
      this.gitClient,
      this.fileSystem,
    ).enumerate(repositoryPath, {
      maxFiles: limits.maxFiles,
      maxDepth: limits.maxDepth,
      include: (path) => LANGUAGE_BY_EXTENSION[extname(path).toLowerCase()] !== undefined,
    });
    warnings.push(...enumeration.warnings);

    const symbols: RepositorySymbol[] = [];
    const needle = query?.toLocaleLowerCase() ?? null;
    let filesScanned = 0;
    let symbolLimitReached = false;
    for (const file of enumeration.files) {
      const definition = LANGUAGE_BY_EXTENSION[extname(file.relativePath).toLowerCase()];
      if (definition === undefined) continue;
      if (file.size > limits.maxFileBytes) continue;
      filesScanned += 1;
      let buffer;
      try {
        buffer = await this.fileSystem.readFile(file.absolutePath);
      } catch {
        warnings.push({ code: "PATH_UNREADABLE", message: `Could not read repository path: ${file.relativePath}` });
        continue;
      }
      if (buffer.subarray(0, 8_192).includes(0)) continue;
      const lines = buffer.toString("utf8").split(/\r?\n/u);
      for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
        const line = lines[lineIndex] ?? "";
        for (const pattern of definition.patterns) {
          const match = pattern.expression.exec(line);
          const name = match?.[1];
          if (name === undefined || (needle !== null && !name.toLocaleLowerCase().includes(needle))) continue;
          symbols.push({
            name,
            kind: pattern.kind,
            path: file.relativePath,
            line: lineIndex + 1,
            column: (match?.index ?? 0) + line.indexOf(name, match?.index ?? 0) + 1,
            language: definition.language,
          });
          if (symbols.length >= limits.maxSymbols) {
            symbolLimitReached = true;
            break;
          }
        }
        if (symbolLimitReached) break;
      }
      if (symbolLimitReached) break;
    }
    if (enumeration.limitReached) warnings.push({ code: "FILE_LIMIT_REACHED", message: `Symbol indexing stopped after ${limits.maxFiles} files.` });
    if (symbolLimitReached) warnings.push({ code: "SYMBOL_LIMIT_REACHED", message: `Symbol indexing stopped after ${limits.maxSymbols} symbols.` });

    return { schemaVersion: 1, root: enumeration.root, query, filesScanned, symbols, warnings };
  }
}
