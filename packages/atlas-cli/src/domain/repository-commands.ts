export type RepositoryCommandCategory =
  | "build"
  | "test"
  | "lint"
  | "format"
  | "typecheck"
  | "dev"
  | "other";

export interface DetectedRepositoryCommand {
  readonly category: RepositoryCommandCategory;
  readonly name: string;
  readonly command: string;
  readonly source: string;
}

export interface RepositoryCommandSummary {
  readonly schemaVersion: 1;
  readonly commands: readonly DetectedRepositoryCommand[];
}
