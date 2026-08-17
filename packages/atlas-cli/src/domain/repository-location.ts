export type RepositoryRelativePath = string & { readonly __repositoryRelativePath: unique symbol };

export interface SourceLocation {
  readonly path: RepositoryRelativePath;
  readonly line: number;
  readonly column?: number;
}

export function normalizeRepositoryRelativePath(value: string): RepositoryRelativePath {
  const normalized = value.replace(/\\/gu, "/").replace(/^\.\//u, "");
  if (normalized.length === 0 || normalized.startsWith("/") || /^[A-Za-z]:\//u.test(normalized)) {
    throw new Error("Repository-relative path must be non-empty and relative.");
  }
  const parts = normalized.split("/");
  if (parts.some((part) => part.length === 0 || part === "." || part === "..")) {
    throw new Error("Repository-relative path must not contain empty, current, or parent segments.");
  }
  return normalized as RepositoryRelativePath;
}
