/**
 * Resolve only names offered AND registered for this run. Exact names win;
 * aliases require a unique match. Deliberately no edit-distance guessing:
 * similar verbs can have very different effects.
 */
export function resolveOfferedToolName(
  requested: string,
  offered: readonly string[],
  registered: readonly string[],
): string | undefined {
  const registeredNames = new Set(registered);
  const eligible = [...new Set(offered)].filter(name => registeredNames.has(name));
  if (eligible.includes(requested)) return requested;
  // An exact but unoffered registered tool must never redirect elsewhere.
  if (registeredNames.has(requested)) return undefined;
  const key = normalizedName(requested);
  if (key === undefined) return undefined;
  const matches = eligible.filter(name => normalizedName(name) === key);
  return matches.length === 1 ? matches[0] : undefined;
}

function normalizedName(name: string): string | undefined {
  if (name.length > 128 || !/^[a-zA-Z][a-zA-Z0-9_.-]*$/u.test(name)) return undefined;
  const parts = name.replace(/([a-z0-9])([A-Z])/gu, "$1.$2").toLowerCase().split(/[._-]+/u);
  if (parts[0] === "repo") parts[0] = "repository";
  if (parts[0] === "repository" && parts[1] === "browser") parts.splice(1, 1);
  if (parts.length < 2 || parts.some(part => part.length === 0)) return undefined;
  // These are source-file reads, not arbitrary "read" or different read APIs.
  if (parts[0] === "repository" && parts.slice(1).join(".") === "read.file") {
    return "repository.read.source";
  }
  return parts.join(".");
}
