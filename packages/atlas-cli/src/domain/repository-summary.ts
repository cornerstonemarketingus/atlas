export interface GitSummary {
  readonly isAvailable: boolean;
  readonly isRepository: boolean;
  readonly branch: string | null;
  readonly headCommit: string | null;
  readonly isDirty: boolean;
}

export interface LanguageSummary {
  readonly name: string;
  readonly fileCount: number;
}

export interface ManifestSummary {
  readonly path: string;
  readonly kind: string;
}

export interface FrameworkSummary {
  readonly name: string;
  readonly evidence: readonly string[];
}

export type ArchitectureRole =
  | "applications"
  | "packages"
  | "services"
  | "source"
  | "tests";

export interface ArchitectureHint {
  readonly path: string;
  readonly role: ArchitectureRole;
}

export interface InspectionWarning {
  readonly code:
    | "GIT_ENUMERATION_FAILED"
    | "GIT_UNAVAILABLE"
    | "MANIFEST_PARSE_FAILED"
    | "PATH_UNREADABLE"
    | "DEPTH_LIMIT_REACHED"
    | "SCAN_LIMIT_REACHED";
  readonly message: string;
}

export interface RepositorySummary {
  readonly schemaVersion: 1;
  readonly root: string;
  readonly repositoryName: string;
  readonly git: GitSummary;
  readonly fileCount: number;
  readonly languages: readonly LanguageSummary[];
  readonly manifests: readonly ManifestSummary[];
  readonly frameworks: readonly FrameworkSummary[];
  readonly architecture: readonly ArchitectureHint[];
  readonly topLevelDirectories: readonly string[];
  readonly warnings: readonly InspectionWarning[];
}
