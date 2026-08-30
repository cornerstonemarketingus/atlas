const ownerPattern = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const namePattern = /^[A-Za-z0-9_.-]{1,100}$/;
const mergePolicies = new Set(["manual", "ci-gated", "none"]);

export function validateRepositorySetting(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { error: "A repository payload is required.", status: 400 };
  }
  const { owner, name, mergePolicy } = body;
  if (typeof owner !== "string" || !ownerPattern.test(owner)) {
    return { error: "Owner is invalid.", status: 400 };
  }
  if (typeof name !== "string" || !namePattern.test(name)) {
    return { error: "Repository name is invalid.", status: 400 };
  }
  if (typeof mergePolicy !== "string" || !mergePolicies.has(mergePolicy)) {
    return { error: "mergePolicy must be 'manual', 'ci-gated', or 'none'.", status: 400 };
  }
  return { setting: { owner: owner.toLowerCase(), name: name.toLowerCase(), mergePolicy } };
}
