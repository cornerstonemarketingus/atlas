/**
 * What a new-project operation is actually doing, in terms a person can act on.
 *
 * The Genesis node reports an operation status and, once a project exists, its
 * lifecycle state. A request that never reached a node has neither, so nothing
 * here supplies a default: an unknown field stays unknown and is not shown. In
 * particular "planning" is never assumed, and an operation id or deployment
 * state is only displayed when the node reported one.
 */

const PLANNING = ["idea", "requirements", "planned", "approved"];
const EXECUTING = ["scaffolding", "building", "verifying", "previewing", "repairing", "reviewing", "ready", "publishing"];

/** Stages the UI distinguishes. Only `executing` and `awaiting-approval` keep polling. */
export const STAGES = Object.freeze(["unavailable", "planning", "executing", "awaiting-approval", "blocked", "interrupted", "failed", "completed", "unknown"]);

const LIFECYCLE_LABELS = Object.freeze({
  idea: "Understanding the request", requirements: "Writing the specification", planned: "Plan ready", approved: "Plan approved",
  scaffolding: "Creating project files", building: "Building", verifying: "Running build and tests", previewing: "Starting a preview",
  repairing: "Repairing a failed check", reviewing: "Reviewing the result", ready: "Verified; preparing to publish", publishing: "Publishing the repository",
});

/** Only a same-origin hosted preview path is ever linked. */
const previewPath = (value) => (typeof value === "string" && /^\/preview\/gen_[0-9a-f-]{36}$/u.test(value) ? value : null);

const text = (value) => (typeof value === "string" && value.trim() ? value.trim().slice(0, 600) : null);

/**
 * @param {{ status?: string, projectState?: string | null, message?: string | null, nextStep?: string | null, reason?: string | null, operationId?: string | null, deploymentState?: string | null, name?: string, visibility?: string, commit?: string | null, repository?: { webUrl?: string, fullName?: string } | null }} result
 */
export function describeProject(result) {
  const status = String(result?.status ?? "");
  const state = String(result?.projectState ?? "");
  const message = text(result?.message);
  const nextStep = text(result?.nextStep);
  const facts = [];
  if (text(result?.name)) facts.push({ label: "Project", value: result.name });
  if (text(result?.visibility)) facts.push({ label: "Visibility", value: result.visibility });
  if (text(result?.operationId)) facts.push({ label: "Operation", value: result.operationId });
  if (text(result?.deploymentState)) facts.push({ label: "Deployment", value: result.deploymentState.replaceAll("-", " ") });
  const base = { facts, detail: message, nextStep, polling: false, previewUrl: null };

  if (status === "unavailable") return { ...base, stage: "unavailable", title: "Project creation is unavailable", detail: message ?? "Atlas could not start this project." };
  if (status === "denied") return { ...base, stage: "failed", title: "Project creation was not allowed" };
  if (status === "not-found") return { ...base, stage: "failed", title: "That project operation was not found" };
  if (status === "failed") return { ...base, stage: "failed", title: "Project creation failed", detail: message ?? "Creation failed. Open the project on the Genesis node for diagnostics." };
  if (status === "interrupted") return { ...base, stage: "interrupted", title: "Project creation was interrupted", detail: message ?? "Atlas restarted while building. Nothing is confirmed complete." };
  if (status === "blocked") return { ...base, stage: "blocked", title: "Project creation needs your input", detail: message ?? "Open the project on the Genesis node to answer its questions." };
  if (status === "awaiting-approval") return { ...base, stage: "awaiting-approval", title: "Waiting for your approval to publish", detail: message ?? "Approve the exact publish action in the Genesis node's Approvals page.", polling: true };
  if (status === "published") return { ...base, stage: "completed", title: "Repository created and pushed" };
  // A hosted website: built and structurally checked, previewable, not published.
  if (status === "ready") return { ...base, stage: "completed", title: "Website built and ready to preview", detail: message ?? "A preview is ready. Nothing is published.", previewUrl: previewPath(result?.previewUrl) };
  if (status === "building" || status === "publishing") {
    const label = LIFECYCLE_LABELS[state] ?? null;
    if (PLANNING.includes(state)) return { ...base, stage: "planning", title: "Planning the project", detail: label, polling: true };
    return { ...base, stage: "executing", title: status === "publishing" ? "Publishing the repository" : "Building the project", detail: label ?? message, polling: true };
  }
  if (EXECUTING.includes(state) && !status) return { ...base, stage: "executing", title: "Building the project", detail: LIFECYCLE_LABELS[state], polling: true };
  return { ...base, stage: "unknown", title: "Project status is not known yet", detail: message ?? "No confirmed progress was reported." };
}
