import type { RepositorySourceReadResult } from "../domain/repository-source.js";

export function renderSourceJson(result: RepositorySourceReadResult): string {
  return JSON.stringify(result, null, 2);
}

export function renderSourceText(result: RepositorySourceReadResult): string {
  const lines = [
    `Root: ${result.root}`,
    `Path: ${result.path}`,
    `Lines: ${result.startLine}-${result.endLine ?? "(none)"}`,
    `Bytes read: ${result.bytesRead}`,
    `Truncated: ${result.truncated ? "yes" : "no"}`,
    "",
  ];
  const sourceLines = result.content.split("\n");
  for (let index = 0; index < sourceLines.length; index += 1) {
    lines.push(`${result.startLine + index}: ${sourceLines[index] ?? ""}`);
  }
  return lines.join("\n");
}
