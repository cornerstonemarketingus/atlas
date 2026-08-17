import type { RepositorySummary } from "../domain/repository-summary.js";

export function renderJson(summary: RepositorySummary): string {
  return JSON.stringify(summary, null, 2);
}

export function renderText(summary: RepositorySummary): string {
  const languages = summary.languages.length === 0
    ? "none detected"
    : summary.languages.map((item) => `${item.name} (${item.fileCount})`).join(", ");
  const manifests = summary.manifests.length === 0
    ? "none detected"
    : summary.manifests.map((item) => `${item.path} [${item.kind}]`).join(", ");
  const frameworks = summary.frameworks.length === 0
    ? "none detected"
    : summary.frameworks.map((item) => item.name).join(", ");
  const architecture = summary.architecture.length === 0
    ? "none detected"
    : summary.architecture.map((item) => `${item.path} [${item.role}]`).join(", ");
  const gitStatus = !summary.git.isAvailable
    ? "unavailable"
    : summary.git.isRepository
      ? `yes (${summary.git.branch ?? "detached"})`
      : "no";
  return [
    `Repository: ${summary.repositoryName}`,
    `Root: ${summary.root}`,
    `Git: ${gitStatus}`,
    `Working tree: ${summary.git.isDirty ? "dirty" : "clean"}`,
    `Files scanned: ${summary.fileCount}`,
    `Languages: ${languages}`,
    `Manifests: ${manifests}`,
    `Frameworks: ${frameworks}`,
    `Architecture: ${architecture}`,
  ].join("\n");
}
