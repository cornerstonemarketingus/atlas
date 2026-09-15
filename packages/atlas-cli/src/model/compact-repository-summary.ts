import type { RepositorySummary } from "../domain/repository-summary.js";

/** Keeps initial hosted-model context bounded; deeper evidence stays available through read tools. */
export function compactRepositorySummary(summary: RepositorySummary): RepositorySummary & { readonly omitted: { readonly manifests: number; readonly architecture: number; readonly topLevelDirectories: number } } {
  const take = <T>(values: readonly T[], maximum: number) => values.slice(0, maximum);
  return {
    schemaVersion: summary.schemaVersion,
    root: summary.root,
    repositoryName: summary.repositoryName,
    git: summary.git,
    fileCount: summary.fileCount,
    languages: take(summary.languages, 12),
    manifests: take(summary.manifests, 20),
    frameworks: take(summary.frameworks, 12),
    architecture: take(summary.architecture, 20),
    topLevelDirectories: take(summary.topLevelDirectories, 30),
    warnings: take(summary.warnings, 10),
    omitted: {
      manifests: Math.max(0, summary.manifests.length - 20),
      architecture: Math.max(0, summary.architecture.length - 20),
      topLevelDirectories: Math.max(0, summary.topLevelDirectories.length - 30),
    },
  };
}
