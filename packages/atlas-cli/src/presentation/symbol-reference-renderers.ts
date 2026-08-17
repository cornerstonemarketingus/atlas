import type { RepositorySymbolReferenceResult } from "../domain/repository-symbol-reference.js";

export function renderSymbolReferenceJson(result: RepositorySymbolReferenceResult): string {
  return JSON.stringify(result, null, 2);
}

export function renderSymbolReferenceText(result: RepositorySymbolReferenceResult): string {
  const lines = [
    `Root: ${result.root}`,
    `Symbol: ${result.query}`,
    `Files scanned: ${result.filesScanned}`,
    `Bytes scanned: ${result.bytesScanned}`,
    `Occurrences: ${result.occurrences.length}`,
  ];
  for (const occurrence of result.occurrences) {
    lines.push(
      `${occurrence.path}:${occurrence.line}:${occurrence.column}: ${occurrence.classification} ${occurrence.name} [${occurrence.language}]`,
    );
  }
  for (const warning of result.warnings) {
    lines.push(`Warning [${warning.code}]: ${warning.message}`);
  }
  return lines.join("\n");
}
