import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { join, relative, isAbsolute, sep } from "node:path";

/**
 * Applies one finished coder lane's patch to the repository it was made
 * for: the owner picks a version in the Command Center and it lands in
 * their working tree (never committed).
 *
 * Writing to the owner's repository is `code.write`: deny refuses, allow
 * applies now, ask (the default) creates an approval bound to a digest of
 * the mission, lane, repository HEAD and patch bytes. If any of those change
 * before the approval is decided, nothing is applied and the owner asks
 * again. `git apply --check` runs first, so a patch that no longer fits is
 * refused rather than half-applied.
 *
 * Pending requests live in memory: after a restart an approved request is
 * reported as expired and the owner applies again.
 */
export class LaneApplyError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "LaneApplyError";
    this.code = code;
  }
}

export function createLaneApplier({ missionService, store, dataDirectory, runGit = git }) {
  const pending = new Map();
  const patchesRoot = join(dataDirectory, "patches");

  async function prepare(missionId, laneId) {
    const mission = missionService.get(missionId);
    if (!mission) throw new LaneApplyError("UNKNOWN_MISSION", "Mission not found.");
    const lane = mission.children.find((child) => child.id === laneId);
    if (!lane) throw new LaneApplyError("UNKNOWN_LANE", `Mission has no lane '${laneId}'.`);
    if (lane.state !== "completed") throw new LaneApplyError("NOT_FINISHED", "Only a finished lane can be applied.");
    const patchPath = lane.result?.handoff?.patch;
    if (typeof patchPath !== "string" || !patchPath) throw new LaneApplyError("NO_PATCH", "This lane produced no changes to apply.");
    const repository = lane.metadata?.repository;
    if (typeof repository !== "string" || !repository) throw new LaneApplyError("NO_REPOSITORY", "This lane has no repository recorded.");

    // Only patches Atlas itself wrote for an isolated run are applied.
    let patch;
    try {
      const [root, resolved] = await Promise.all([realpath(patchesRoot), realpath(patchPath)]);
      const inside = relative(root, resolved);
      if (inside === "" || inside.startsWith(`..${sep}`) || inside === ".." || isAbsolute(inside)) throw new Error("outside");
      patch = { path: resolved, bytes: await readFile(resolved) };
    } catch {
      throw new LaneApplyError("NO_PATCH", "The lane's patch is missing or is not one Atlas produced.");
    }
    const head = await runGit(repository, ["rev-parse", "HEAD"]);
    if (head.code !== 0) throw new LaneApplyError("NO_REPOSITORY", "The lane's repository is not a Git work tree any more.");
    const title = lane.metadata?.variant ? `version ${lane.metadata.variant} of ${lane.metadata.variants}` : `lane ${lane.id}`;
    const digest = createHash("sha256").update(JSON.stringify({
      missionId, laneId, repository, head: head.stdout.trim(), patch: createHash("sha256").update(patch.bytes).digest("hex"),
    })).digest("hex");
    return { missionId, laneId, repository, patch, digest, summary: `Apply ${title} of "${(mission.title || mission.id).slice(0, 120)}" to ${repository}` };
  }

  async function apply(request) {
    const check = await runGit(request.repository, ["apply", "--check", request.patch.path]);
    if (check.code !== 0) {
      store.audit("lane.apply_refused", `${request.missionId}/${request.laneId}: patch does not apply`);
      return { status: "conflict", message: `The patch no longer applies cleanly: ${check.stderr.trim().slice(0, 500) || "git apply --check failed"}` };
    }
    const applied = await runGit(request.repository, ["apply", request.patch.path]);
    if (applied.code !== 0) return { status: "failed", message: applied.stderr.trim().slice(0, 500) || "git apply failed." };
    store.audit("lane.applied", `${request.missionId}/${request.laneId} -> ${request.repository}`);
    return { status: "applied", repository: request.repository, message: "Applied to the working tree. Review and commit it when you are happy." };
  }

  return {
    /** Applies now, or asks first, per the code.write policy. */
    async request(missionId, laneId) {
      const request = await prepare(missionId, laneId);
      const { decision } = store.policy("code.write");
      if (decision === "deny") throw new LaneApplyError("DENIED_BY_POLICY", "Local policy denies code.write.");
      if (decision === "allow") return apply(request);
      const approval = store.createApproval({ capability: "code.write", summary: request.summary, actionDigest: request.digest });
      pending.set(approval.id, request);
      return { status: "awaiting-approval", approval };
    },

    /** Called for every decided approval; acts only on its own. */
    async onApprovalDecided(approval) {
      const request = approval?.id ? pending.get(approval.id) : null;
      if (!request) return null;
      pending.delete(approval.id);
      if (approval.status !== "approved") return { status: "denied" };
      let current;
      try { current = await prepare(request.missionId, request.laneId); } catch (error) { return { status: "stale", message: error.message }; }
      if (current.digest !== approval.actionDigest) {
        store.audit("lane.apply_refused", `${request.missionId}/${request.laneId}: changed after approval`);
        return { status: "stale", message: "The repository or the patch changed after you approved this; ask again." };
      }
      return apply(current);
    },
  };
}

function git(cwd, args) {
  return new Promise((resolve) => {
    execFile("git", ["-C", cwd, ...args], { timeout: 60_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      resolve({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
    });
  });
}
