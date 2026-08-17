import type { RepositoryTreeResult } from "../domain/repository-tree.js";

export function renderTreeJson(result: RepositoryTreeResult): string {
  return JSON.stringify(result, null, 2);
}

export function renderTreeText(result: RepositoryTreeResult): string {
  const lines = [`Repository tree: ${result.root}`];
  for (const entry of result.entries) {
    const name = entry.path.split("/").at(-1) ?? entry.path;
    lines.push(`${"  ".repeat(entry.depth)}${name}${entry.kind === "directory" ? "/" : ""}`);
  }
  if (result.truncated) lines.push("[tree truncated]");
  for (const warning of result.warnings) lines.push(`Warning: ${warning}`);
  return lines.join("\n");
}
