import type { RepositorySummary } from "./repository-summary.js";

export interface RepositoryInspector {
  inspect(repositoryPath: string): Promise<RepositorySummary>;
}
