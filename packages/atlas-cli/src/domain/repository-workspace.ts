import type { InspectionWarning } from "./repository-summary.js";

export interface DetectedLockfile {
  readonly path: string;
  readonly packageManager: string;
}

export type WorkspaceDeclarationKind =
  | "npm-workspaces"
  | "pnpm-workspaces"
  | "cargo-workspace";

export interface DetectedWorkspaceDeclaration {
  readonly manifestPath: string;
  readonly kind: WorkspaceDeclarationKind;
  readonly patterns: readonly string[];
}

export interface RepositoryWorkspaceSummary {
  readonly schemaVersion: 1;
  readonly lockfiles: readonly DetectedLockfile[];
  readonly workspaceDeclarations: readonly DetectedWorkspaceDeclaration[];
  readonly warnings: readonly InspectionWarning[];
}
