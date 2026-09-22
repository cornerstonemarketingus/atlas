const DEFAULT_SELF_REPOSITORIES = "cornerstonemarketingus/atlas";

export function protectedRepositories(value = DEFAULT_SELF_REPOSITORIES) {
  return new Set(String(value).split(",").map((item) => item.trim().toLowerCase()).filter(Boolean));
}

export function isDeploymentOwner(account) {
  return account?.userId === "operator";
}

/**
 * Atlas may propose changes to its own repository only for the deployment
 * owner. A subscription is an entitlement to product features, never an
 * elevation into the control plane that maintains Atlas itself.
 */
export function selfModificationDecision(account, task, environment = process.env) {
  const protectedSet = protectedRepositories(environment.ATLAS_SELF_REPOSITORIES);
  const targetsAtlas = task?.mode === "coder" && protectedSet.has(String(task.repository ?? "").toLowerCase());
  if (!targetsAtlas) return { allowed: true };
  if (isDeploymentOwner(account)) return { allowed: true };
  return {
    allowed: false,
    status: 403,
    reason: "Only the Atlas deployment owner can run coder mode against Atlas's protected repositories.",
  };
}
