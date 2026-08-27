export type ManifestEcosystem =
  | "npm"
  | "python-pep621"
  | "python-poetry"
  | "python-requirements"
  | "cargo"
  | "go";

export interface ManifestDependency {
  readonly name: string;
  readonly versionRange: string | null;
}

export interface RepositoryManifest {
  readonly ecosystem: ManifestEcosystem;
  readonly path: string;
  readonly name: string | null;
  readonly version: string | null;
  readonly dependencies: readonly ManifestDependency[];
  readonly devDependencies: readonly ManifestDependency[];
}

export interface RepositoryManifestSummary {
  readonly schemaVersion: 1;
  readonly manifests: readonly RepositoryManifest[];
}
