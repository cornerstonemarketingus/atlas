import { createHash } from "node:crypto";
import { git } from "../engineering/git.mjs";

/**
 * Publishing a finished Genesis project is a consequential, external action,
 * so it goes through Atlas's existing policy and approval system, never
 * around it:
 *
 * - The `publish.remote` policy decides: "deny" refuses, "ask" (the default)
 *   creates an approval in the owner's normal Approvals list (and on paired
 *   phones), "allow" proceeds.
 * - The approval is bound to the exact action: project, destination and the
 *   commit being published. If the project changes after the request, the
 *   approval no longer matches and the push is refused.
 * - The push uses the owner's own git setup (credential manager, SSH keys);
 *   Atlas stores no host token for this. The destination must already exist
 *   (an empty repository the owner created); creating repositories or
 *   deploying to hosting providers are separate, later handoffs.
 * - Every step is a lifecycle transition with evidence:
 *   ready → publishing → published, or back to ready with the reason.
 */

const REMOTE = /^(https:\/\/[^\s/@]+(:\d+)?\/[\w.@~-]+(\/[\w.@~-]+)*?(\.git)?|git@[\w.-]+:[\w.~-]+(\/[\w.~-]+)*?(\.git)?|ssh:\/\/git@[\w.-]+(:\d+)?\/[\w.~-]+(\/[\w.~-]+)*?(\.git)?)$/u;

export class PublishError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "PublishError";
    this.code = code;
  }
}

export function assertRemote(remote) {
  const value = String(remote ?? "").trim();
  if (!REMOTE.test(value)) throw new PublishError("INVALID_REMOTE", "Use the repository address from your git host, like https://github.com/you/app.git or git@github.com:you/app.git (no passwords in the address).");
  return value;
}

export function publishDigest({ projectId, remote, commit }) {
  return createHash("sha256").update(JSON.stringify({ projectId, remote, commit, action: "genesis.publish.git" })).digest("hex");
}

export class GenesisPublisher {
  /**
   * @param {{ genesis: import("./service.mjs").GenesisService,
   *   approvals: { policy: (capability: string) => { decision: string }, create: (request: { capability: string, summary: string, actionDigest: string }) => { id: string }, get: (id: string) => object|null },
   *   push?: (folder: string, remote: string) => Promise<{ ok: boolean, message: string }> }} options
   */
  constructor({ genesis, approvals, push = pushMain }) {
    this.genesis = genesis;
    this.approvals = approvals;
    this.push = push;
  }

  /** Asks to publish; returns what happened: refused, awaiting approval, or the publish result. */
  async request(projectId, { remote }) {
    const project = this.genesis.store.get(this.genesis.tenantId, projectId);
    if (!["ready", "published"].includes(project.state)) throw new PublishError("NOT_READY", "Only a ready project can be published.");
    const destination = assertRemote(remote);
    const commit = (await git(project.workspace, ["rev-parse", "HEAD"])).stdout.trim();
    const digest = publishDigest({ projectId, remote: destination, commit });
    const decision = this.approvals.policy("publish.remote").decision;
    if (decision === "deny") throw new PublishError("DENIED_BY_POLICY", "Your policy does not allow publishing (publish.remote is set to deny in Settings → Policies).");
    if (decision === "allow") return this.#publish(project, destination, commit, { approval: null, policy: "allow" });
    const approval = this.approvals.create({ capability: "publish.remote", summary: `Publish "${project.name}" (commit ${commit.slice(0, 8)}) to ${destination}`, actionDigest: digest });
    this.genesis.store.recordPublishRequest(projectId, { approvalId: approval.id, remote: destination, commit });
    return { status: "awaiting-approval", approvalId: approval.id, remote: destination, commit };
  }

  /** Called for every decided approval; acts only on this publisher's own requests, and only when the project is unchanged. */
  async onApprovalDecided(approval) {
    const request = approval?.id ? this.genesis.store.takePublishRequest(approval.id) : null;
    if (!request) return null;
    if (approval.status !== "approved") return { status: "denied" };
    const project = this.genesis.store.get(this.genesis.tenantId, request.projectId);
    const commit = (await git(project.workspace, ["rev-parse", "HEAD"])).stdout.trim();
    if (approval.actionDigest !== publishDigest({ projectId: project.id, remote: request.remote, commit }) || commit !== request.commit) {
      return { status: "stale", message: "The project changed after you approved publishing it; ask to publish again." };
    }
    if (!["ready", "published"].includes(project.state)) return { status: "stale", message: `The project is ${project.state}; publish it again when it is ready.` };
    return this.#publish(project, request.remote, commit, { approval: approval.id, policy: "ask" });
  }

  async #publish(project, remote, commit, { approval, policy }) {
    this.genesis.advance(project.id, "publishing", { reason: `Publishing to ${remote}.`, evidence: { kind: "publish", remote, commit, approval, policy } });
    const result = await this.push(project.workspace, remote);
    if (!result.ok) {
      this.genesis.advance(project.id, "ready", { reason: `Publishing failed: ${result.message}`.slice(0, 900), evidence: { kind: "publish-failed", remote, commit, message: result.message.slice(0, 2000) } });
      return { status: "failed", message: result.message };
    }
    this.genesis.advance(project.id, "published", { reason: `Published to ${remote}.`, evidence: { kind: "published", remote, commit, approval } });
    return { status: "published", remote, commit };
  }
}

/** Pushes the project's main branch using the owner's own git credentials; never prompts (no terminal is attached). */
export async function pushMain(folder, remote) {
  try {
    await git(folder, ["push", remote, "HEAD:refs/heads/main"], { env: { GIT_TERMINAL_PROMPT: "0" }, timeoutMs: 120_000 });
    return { ok: true, message: "pushed" };
  } catch (error) {
    return { ok: false, message: String(error?.stderr || error?.message || "git push failed").trim().slice(-1500) };
  }
}
