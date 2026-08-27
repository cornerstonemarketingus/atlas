export interface CodeownersEntry {
  readonly pattern: string;
  readonly owners: readonly string[];
  readonly lineNumber: number;
}

export interface RepositoryOwnershipIndex {
  readonly schemaVersion: 1;
  readonly sourcePath: string | null;
  readonly entries: readonly CodeownersEntry[];
}

/**
 * Resolves the owners for a repository-relative path using GitHub's
 * CODEOWNERS semantics: the last matching pattern in file order wins.
 */
export function resolveOwners(
  index: RepositoryOwnershipIndex,
  repositoryRelativePath: string,
): readonly string[] {
  const normalizedPath = normalizePath(repositoryRelativePath);
  let matched: CodeownersEntry | null = null;

  for (const entry of index.entries) {
    if (patternToRegExp(entry.pattern).test(normalizedPath)) matched = entry;
  }

  return matched === null ? [] : matched.owners;
}

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\/+/, "");
}

const GLOBSTAR = Symbol("globstar");
type PatternSegment = string | typeof GLOBSTAR;

/**
 * Translates a CODEOWNERS (gitignore-style) pattern into a RegExp.
 *
 * Rules implemented:
 * - A leading "/" anchors the pattern to the repository root.
 * - A pattern without an interior "/" matches at any depth.
 * - "**" matches across directory boundaries, including zero directories.
 * - "*" matches within a single path segment (not "/").
 * - A trailing "/" matches the directory and everything beneath it, but not
 *   a file bearing exactly that name.
 */
function patternToRegExp(rawPattern: string): RegExp {
  let pattern = rawPattern;

  const isAnchored = pattern.startsWith("/");
  if (isAnchored) pattern = pattern.slice(1);

  const isDirectory = pattern.endsWith("/") && pattern.length > 1;
  if (isDirectory) pattern = pattern.slice(0, -1);

  const hasInteriorSlash = pattern.includes("/");
  const body = pattern === "**" ? ".*" : segmentsToRegExpSource(pattern.split("/"));

  const prefix = isAnchored || hasInteriorSlash ? "^" : "(^|/)";
  const suffix = isDirectory ? "/.*$" : "(/.*)?$";
  return new RegExp(`${prefix}${body}${suffix}`);
}

function segmentsToRegExpSource(rawSegments: readonly string[]): string {
  const segments: PatternSegment[] = [];
  for (const raw of rawSegments) {
    const token: PatternSegment = raw === "**" ? GLOBSTAR : raw;
    if (token === GLOBSTAR && segments[segments.length - 1] === GLOBSTAR) continue;
    segments.push(token);
  }

  let body = "";
  let previousConsumedTrailingSlash = false;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (segment === undefined) continue;

    if (segment === GLOBSTAR) {
      if (index === 0) {
        // Leading "**/" matches zero or more directories.
        body += "(?:.*/)?";
        previousConsumedTrailingSlash = true;
      } else {
        // A "**" in the middle or at the end matches zero or more
        // directories, anchored to the slash that precedes it.
        body += "(?:/.*)?";
        previousConsumedTrailingSlash = false;
      }
      continue;
    }

    if (index > 0 && !previousConsumedTrailingSlash) body += "/";
    body += segmentToFragment(segment);
    previousConsumedTrailingSlash = false;
  }
  return body;
}

function segmentToFragment(segment: string): string {
  let fragment = "";
  for (const char of segment) {
    if (char === "*") fragment += "[^/]*";
    else if (char === "?") fragment += "[^/]";
    else fragment += escapeRegExpLiteral(char);
  }
  return fragment;
}

function escapeRegExpLiteral(char: string): string {
  return /[.+^${}()|[\]\\]/.test(char) ? `\\${char}` : char;
}
