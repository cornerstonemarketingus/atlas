/**
 * The platform GitHub token from the Worker's environment, cleaned up.
 *
 * A token pasted into a repository secret often carries a trailing newline,
 * surrounding spaces or quotes, or a "Bearer "/"token " prefix copied from an
 * example. GitHub answers any of those with 401, which Atlas reports as
 * "expired or revoked" — a misleading dead end for a token that is fine.
 * Returns undefined when unset.
 */
export function platformGitHubToken(environment = process.env) {
  const raw = environment.ATLAS_GITHUB_TOKEN;
  if (typeof raw !== "string") return undefined;
  const cleaned = raw.trim().replace(/^["']|["']$/gu, "").trim().replace(/^(bearer|token)\s+/iu, "").trim();
  return cleaned || undefined;
}
