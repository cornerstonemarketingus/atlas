import type { RepositorySearchResult } from "../domain/repository-search.js";

export function renderSearchJson(result: RepositorySearchResult): string {
  return JSON.stringify(result, null, 2);
}

export function renderSearchText(result: RepositorySearchResult): string {
  const lines = [
    `Search: ${result.query}`,
    `Root: ${result.root}`,
    `Files scanned: ${result.filesScanned}`,
    `Matches: ${result.matches.length}`,
  ];
  for (const match of result.matches) {
    lines.push(match.kind === "file"
      ? `${match.path}`
      : `${match.path}:${match.line}:${match.column}: ${match.preview}`);
  }
  for (const warning of result.warnings) lines.push(`Warning [${warning.code}]: ${warning.message}`);
  return lines.join("\n");
}
