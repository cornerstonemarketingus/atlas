import { extname } from "node:path";
import type {
  RepositorySymbolOccurrence,
  RepositorySymbolReferenceFinder as RepositorySymbolReferenceFinderContract,
  RepositorySymbolReferenceOptions,
  RepositorySymbolReferenceResult,
  RepositorySymbolReferenceWarning,
} from "../domain/repository-symbol-reference.js";
import { GitClient } from "./git-client.js";
import { RepositoryFileEnumerator } from "./repository-file-enumerator.js";
import {
  nodeRepositoryFileSystem,
  type RepositoryFileSystem,
} from "./repository-file-system.js";

const DEFAULTS = {
  maxFiles: 20_000,
  maxResults: 1_000,
  maxFileBytes: 1024 * 1024,
  maxTotalBytes: 32 * 1024 * 1024,
  maxDepth: 25,
};

type SupportedLanguage = RepositorySymbolOccurrence["language"];

const LANGUAGE_BY_EXTENSION: Readonly<Record<string, SupportedLanguage>> = {
  ".cjs": "javascript", ".js": "javascript", ".jsx": "javascript", ".mjs": "javascript",
  ".py": "python",
  ".ts": "typescript", ".tsx": "typescript",
};

function escapeExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function declarationColumn(line: string, name: string, language: SupportedLanguage): number | null {
  const escaped = escapeExpression(name);
  const prefix = language === "python"
    ? `^\\s*(?:async\\s+def|def|class)\\s+(${escaped})\\b`
    : `^\\s*(?:export\\s+)?(?:default\\s+)?(?:declare\\s+)?(?:(?:async\\s+)?function|class|interface|type|(?:const\\s+)?enum)\\s+(${escaped})\\b`;
  const match = new RegExp(prefix, "u").exec(line);
  return match?.[1] === undefined ? null : line.indexOf(match[1], match.index) + 1;
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer.`);
}

export class RepositorySymbolReferenceFinder implements RepositorySymbolReferenceFinderContract {
  public constructor(
    private readonly gitClient: GitClient = new GitClient(),
    private readonly fileSystem: RepositoryFileSystem = nodeRepositoryFileSystem,
  ) {}

  public async find(
    repositoryPath: string,
    symbolName: string,
    options: RepositorySymbolReferenceOptions = {},
  ): Promise<RepositorySymbolReferenceResult> {
    const query = symbolName.trim();
    if (!/^[A-Za-z_$][\w$]*$/u.test(query) || query.length > 200) {
      throw new Error("Symbol name must be a valid identifier containing at most 200 characters.");
    }
    const limits = { ...DEFAULTS, ...options };
    assertPositiveInteger(limits.maxFiles, "maxFiles");
    assertPositiveInteger(limits.maxResults, "maxResults");
    assertPositiveInteger(limits.maxFileBytes, "maxFileBytes");
    assertPositiveInteger(limits.maxTotalBytes, "maxTotalBytes");
    if (!Number.isInteger(limits.maxDepth) || limits.maxDepth < 0) throw new Error("maxDepth must be non-negative.");

    const enumeration = await new RepositoryFileEnumerator(this.gitClient, this.fileSystem).enumerate(
      repositoryPath,
      {
        maxFiles: limits.maxFiles,
        maxDepth: limits.maxDepth,
        include: (path) => LANGUAGE_BY_EXTENSION[extname(path).toLowerCase()] !== undefined,
      },
    );
    const warnings: RepositorySymbolReferenceWarning[] = [...enumeration.warnings];
    const occurrences: RepositorySymbolOccurrence[] = [];
    const identifier = new RegExp(`(?<![\\w$])${escapeExpression(query)}(?![\\w$])`, "gu");
    let filesScanned = 0;
    let bytesScanned = 0;
    let resultLimitReached = false;
    let byteLimitReached = false;

    for (const file of enumeration.files) {
      if (file.size > limits.maxFileBytes) {
        warnings.push({ code: "FILE_TOO_LARGE", message: `Skipped ${file.relativePath}; it exceeds ${limits.maxFileBytes} bytes.` });
        continue;
      }
      if (bytesScanned + file.size > limits.maxTotalBytes) {
        byteLimitReached = true;
        break;
      }
      let buffer: Buffer;
      try {
        buffer = await this.fileSystem.readFile(file.absolutePath);
      } catch {
        warnings.push({ code: "PATH_UNREADABLE", message: `Could not read repository path: ${file.relativePath}` });
        continue;
      }
      if (buffer.byteLength > limits.maxFileBytes) {
        warnings.push({ code: "FILE_TOO_LARGE", message: `Skipped ${file.relativePath}; it exceeds ${limits.maxFileBytes} bytes.` });
        continue;
      }
      if (bytesScanned + buffer.byteLength > limits.maxTotalBytes) {
        byteLimitReached = true;
        break;
      }
      if (buffer.subarray(0, 8_192).includes(0)) continue;
      filesScanned += 1;
      bytesScanned += buffer.byteLength;
      const language = LANGUAGE_BY_EXTENSION[extname(file.relativePath).toLowerCase()];
      if (language === undefined) continue;
      const lines = buffer.toString("utf8").split(/\r?\n/u);
      for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
        const line = lines[lineIndex] ?? "";
        const declaredAt = declarationColumn(line, query, language);
        identifier.lastIndex = 0;
        for (const match of line.matchAll(identifier)) {
          const column = (match.index ?? 0) + 1;
          occurrences.push({
            name: query,
            classification: column === declaredAt ? "declaration" : "reference",
            path: file.relativePath,
            line: lineIndex + 1,
            column,
            language,
          });
          if (occurrences.length >= limits.maxResults) {
            resultLimitReached = true;
            break;
          }
        }
        if (resultLimitReached) break;
      }
      if (resultLimitReached) break;
    }
    if (enumeration.limitReached) warnings.push({ code: "FILE_LIMIT_REACHED", message: `Reference search was bounded to ${limits.maxFiles} files.` });
    if (byteLimitReached) warnings.push({ code: "TOTAL_BYTE_LIMIT_REACHED", message: `Reference search stopped before exceeding ${limits.maxTotalBytes} bytes.` });
    if (resultLimitReached) warnings.push({ code: "RESULT_LIMIT_REACHED", message: `Reference search stopped after ${limits.maxResults} occurrences.` });

    return { schemaVersion: 1, root: enumeration.root, query, filesScanned, bytesScanned, occurrences, warnings };
  }
}
