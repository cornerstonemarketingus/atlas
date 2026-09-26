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

/** An { owner, name } reference (DELETE), normalized like validateRepositorySetting. */
export function validateRepositoryReference(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { error: "A repository payload is required.", status: 400 };
  }
  const { owner, name } = body;
  if (typeof owner !== "string" || !ownerPattern.test(owner)) return { error: "Owner is invalid.", status: 400 };
  if (typeof name !== "string" || !namePattern.test(name)) return { error: "Repository name is invalid.", status: 400 };
  return { reference: { owner: owner.toLowerCase(), name: name.toLowerCase() } };
}

/**
 * A tenant may only allowlist repositories inside the deployment-wide
 * ATLAS_ALLOWED_REPOSITORIES upper bound, and only the default (deployment-owner) tenant may
 * choose the zero-gate "none" merge policy: one deployment repository can be
 * allowlisted by several tenants, and one of them must not be able to turn on
 * unverified auto-merge for everyone.
 */
export function tenantRepositoryDecision(setting, { deploymentAllowlist, defaultTenant }) {
  const full = `${setting.owner}/${setting.name}`;
  if (!deploymentAllowlist.has(full)) {
    return { allowed: false, status: 403, error: "That repository is not in this deployment's ATLAS_ALLOWED_REPOSITORIES." };
  }
  if (setting.mergePolicy === "none" && !defaultTenant) {
    return { allowed: false, status: 403, error: "Only the deployment owner can use the 'none' merge policy." };
  }
  return { allowed: true };
}
