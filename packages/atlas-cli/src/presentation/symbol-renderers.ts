import type { RepositorySymbolResult } from "../domain/repository-symbol.js";

export function renderSymbolJson(result: RepositorySymbolResult): string {
  return JSON.stringify(result, null, 2);
}

export function renderSymbolText(result: RepositorySymbolResult): string {
  const lines = [
    `Root: ${result.root}`,
    `Query: ${result.query ?? "(all symbols)"}`,
    `Files scanned: ${result.filesScanned}`,
    `Symbols: ${result.symbols.length}`,
  ];
  for (const symbol of result.symbols) {
    lines.push(`${symbol.path}:${symbol.line}:${symbol.column}: ${symbol.kind} ${symbol.name} [${symbol.language}]`);
  }
  for (const warning of result.warnings) lines.push(`Warning [${warning.code}]: ${warning.message}`);
  return lines.join("\n");
}
