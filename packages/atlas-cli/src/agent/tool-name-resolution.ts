/**
 * Resolve only names offered AND registered for this run. Exact names win;
 * aliases require a unique registered match which is also offered. Only a
 * single typo in a long namespace may be fuzzy matched; operation names must
 * match exactly because similar verbs can have very different effects.
 */
export function resolveOfferedToolName(
  requested: string,
  offered: readonly string[],
  registered: readonly string[],
): string | undefined {
  const registeredNames = new Set(registered);
  const offeredNames = new Set(offered);
  const eligible = [...registeredNames].filter(name => offeredNames.has(name));
  if (eligible.includes(requested)) return requested;
  // An exact but unoffered registered tool must never redirect elsewhere.
  if (registeredNames.has(requested)) return undefined;
  const key = normalizedName(requested);
  if (key === undefined) return undefined;
  const candidates = [...registeredNames].map(name => ({ name, key: normalizedName(name) }));
  // Check every registered name before availability: hiding one ambiguous
  // candidate from this model must not change which operation an alias means.
  const normalizedMatches = candidates.filter(candidate => candidate.key === key);
  if (normalizedMatches.length > 0) return uniqueOffered(normalizedMatches, offeredNames);
  const parts = key.split(".");
  if (parts.length < 2) return undefined;
  const namespace = parts[0]!;
  const operation = parts.slice(1).join(".");
  return uniqueOffered(candidates.filter(candidate => {
    if (candidate.key === undefined) return false;
    const canonicalParts = candidate.key.split(".");
    return canonicalParts.slice(1).join(".") === operation
      && singleNamespaceTypo(namespace, canonicalParts[0]!);
  }), offeredNames);
}

function uniqueOffered(matches: readonly { readonly name: string }[], offered: ReadonlySet<string>): string | undefined {
  const name = matches.length === 1 ? matches[0]?.name : undefined;
  return name !== undefined && offered.has(name) ? name : undefined;
}

function normalizedName(name: string): string | undefined {
  if (name.length > 128 || !/^[a-zA-Z][a-zA-Z0-9_.-]*$/u.test(name)) return undefined;
  const parts = name.replace(/([A-Z])([A-Z][a-z])/gu, "$1.$2")
    .replace(/([a-z0-9])([A-Z])/gu, "$1.$2").toLowerCase().split(/[._-]+/u);
  if (parts[0] === "repo" || parts[0] === "repos" || parts[0] === "repositories") parts[0] = "repository";
  if (parts[0] === "repository" && parts[1] === "browser") parts.splice(1, 1);
  if (parts.length < 2 || parts.some(part => part.length === 0)) return undefined;
  // These are source-file reads, not arbitrary "read" or different read APIs.
  if (parts[0] === "repository" && parts.slice(1).join(".") === "read.file") {
    return "repository.read.source";
  }
  return parts.join(".");
}

/** At most one insertion, deletion, substitution or adjacent transposition. */
function singleNamespaceTypo(left: string, right: string): boolean {
  // Short names are too easy to confuse. Keep similarity at or above 85%.
  if (Math.min(left.length, right.length) < 6 || 1 / Math.max(left.length, right.length) > 0.15
    || Math.abs(left.length - right.length) > 1 || left === right) return false;
  let index = 0;
  while (index < Math.min(left.length, right.length) && left[index] === right[index]) index++;
  if (left.length === right.length) {
    return left.slice(index + 1) === right.slice(index + 1)
      || (left[index] === right[index + 1] && left[index + 1] === right[index]
        && left.slice(index + 2) === right.slice(index + 2));
  }
  return left.length > right.length
    ? left.slice(index + 1) === right.slice(index)
    : left.slice(index) === right.slice(index + 1);
}
