import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { git } from "../engineering/git.mjs";
import { createRepositoryCreator } from "../../agent/infrastructure/git-hosts.mjs";
import { createVercelAdapter } from "../../agent/infrastructure/vercel.mjs";
import { getTemplate } from "./templates/index.mjs";

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
 *
 * Two more external handoffs use the existing infrastructure adapters in the
 * same plan → approve → apply → verify shape:
 * - creating a repository on GitHub, GitLab or Forgejo (git-hosts.mjs), then
 *   pushing to it; approved under `publish.remote`;
 * - deploying a built static site to Vercel (vercel.mjs), approved under
 *   `deploy.remote`. The approval covers the exact files (their hashes), so a
 *   rebuilt site needs a new approval. Apps that need a running server (the
 *   web-app and api-service templates) are not deployable to static hosting,
 *   and Genesis says so instead of pretending.
 * Tokens come from the credential vault (or the environment), are used only
 * inside the adapters, and never appear in plans, approvals or evidence.
 */

const TOKENS = { github: "ATLAS_GITHUB_TOKEN", gitlab: "ATLAS_GITLAB_TOKEN", forgejo: "ATLAS_FORGEJO_TOKEN", vercel: "ATLAS_VERCEL_TOKEN" };

/** The built files of a static site (dist/), as { file, data } with forward-slash paths. */
export function collectStaticFiles(folder) {
  const root = join(folder, "dist");
  const files = [];
  (function walk(directory) {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      if (statSync(path).isDirectory()) walk(path);
      else files.push({ file: relative(root, path).split("\\").join("/"), data: readFileSync(path) });
    }
  })(root);
  return files.sort((a, b) => a.file.localeCompare(b.file));
}

export function deploymentName(projectName) {
  return String(projectName).toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "").slice(0, 60) || "atlas-site";
}

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
  constructor({ genesis, approvals, push = pushMain, credentials = async (name) => process.env[name] ?? null, runCheck = null, environment = process.env, adapters = {} }) {
    this.genesis = genesis;
    this.approvals = approvals;
    this.push = push;
    this.credentials = credentials;
    this.runCheck = runCheck;
    this.environment = environment;
    this.adapters = { repositoryCreator: createRepositoryCreator, vercel: createVercelAdapter, ...adapters };
  }

  #readyProject(projectId) {
    const project = this.genesis.store.get(this.genesis.tenantId, projectId);
    if (!["ready", "published"].includes(project.state)) throw new PublishError("NOT_READY", "Only a ready project can be published or deployed.");
    return project;
  }

  #policy(capability, label) {
    const decision = this.approvals.policy(capability).decision;
    if (decision === "deny") throw new PublishError("DENIED_BY_POLICY", `Your policy does not allow ${label} (${capability} is set to deny in Settings → Policies).`);
    return decision;
  }

  async #token(provider) {
    const token = await this.credentials(TOKENS[provider]);
    if (!token) throw new PublishError("NO_CREDENTIAL", `Add a ${provider} token as ${TOKENS[provider]} (Settings → Credentials, or the environment) so Atlas can do this for you.`);
    return token;
  }

  async #creator(host, baseUrl) {
    return this.adapters.repositoryCreator({ host, token: await this.#token(host), baseUrl });
  }

  async #vercel() {
    return this.adapters.vercel({ token: await this.#token("vercel"), teamId: this.environment.ATLAS_VERCEL_TEAM_ID || null });
  }

  /** Create a repository on a git host (plan now, create after approval), then push the project to it. */
  async requestRepository(projectId, { host = "github", name = null, visibility = "private", baseUrl = null } = {}) {
    const project = this.#readyProject(projectId);
    if (!["github", "gitlab", "forgejo"].includes(host)) throw new PublishError("BAD_HOST", "Choose github, gitlab or forgejo.");
    const decision = this.#policy("publish.remote", "publishing");
    const creator = await this.#creator(host, baseUrl);
    const plan = await creator.planRepository({ name: name ?? deploymentName(project.name), visibility, description: project.spec.objective.slice(0, 200) }).catch((error) => { throw new PublishError(error.code ?? "PLAN_FAILED", error.message); });
    const commit = (await git(project.workspace, ["rev-parse", "HEAD"])).stdout.trim();
    const stored = { ...plan, host, baseUrl };
    if (decision === "allow") return this.#createRepository(project, stored, commit, { approval: null });
    const approval = this.approvals.create({ capability: "publish.remote", summary: `Create ${plan.target} on ${host} and publish "${project.name}" (commit ${commit.slice(0, 8)}) to it`, actionDigest: publishDigest({ projectId, remote: plan.digest, commit }), riskLevel: 3 });
    this.genesis.store.recordPublishRequest(projectId, { approvalId: approval.id, remote: plan.digest, commit, kind: "repository", plan: stored });
    return { status: "awaiting-approval", approvalId: approval.id, plan: { target: plan.target, notes: plan.notes }, commit };
  }

  async #createRepository(project, plan, commit, { approval }) {
    this.genesis.advance(project.id, "publishing", { reason: `Creating ${plan.target} on ${plan.host}.`, evidence: { kind: "publish", repository: plan.target, host: plan.host, commit, approval, plan: plan.digest } });
    let created;
    try {
      created = await (await this.#creator(plan.host, plan.baseUrl)).applyRepository({ plan });
    } catch (error) {
      this.genesis.advance(project.id, "ready", { reason: `Creating the repository failed: ${error.message}`.slice(0, 900), evidence: { kind: "publish-failed", step: "create", message: String(error.message).slice(0, 2000) } });
      return { status: "failed", message: error.message };
    }
    if (!created.verified || !created.observed?.cloneUrl) {
      this.genesis.advance(project.id, "ready", { reason: "The host did not confirm the new repository.", evidence: { kind: "publish-failed", step: "verify", observed: created.observed } });
      return { status: "failed", message: "The host did not confirm the new repository." };
    }
    const pushed = await this.push(project.workspace, created.observed.cloneUrl);
    if (!pushed.ok) {
      this.genesis.advance(project.id, "ready", { reason: `Created ${created.observed.webUrl ?? created.observed.fullName}, but pushing failed: ${pushed.message}`.slice(0, 900), evidence: { kind: "publish-failed", step: "push", repository: created.observed, message: pushed.message.slice(0, 2000) } });
      return { status: "failed", repository: created.observed, message: pushed.message };
    }
    this.genesis.advance(project.id, "published", { reason: `Published to ${created.observed.webUrl ?? created.observed.cloneUrl}.`, evidence: { kind: "published", repository: created.observed, commit, approval } });
    return { status: "published", repository: created.observed, commit };
  }

  /** Deploy a built static site to Vercel (plan now, deploy after approval). */
  async requestDeployment(projectId, { provider = "vercel", target = "preview" } = {}) {
    const project = this.#readyProject(projectId);
    if (provider !== "vercel") throw new PublishError("BAD_PROVIDER", "Atlas deploys to Vercel today; other hosts are reached by publishing the repository.");
    const template = getTemplate(project.plan.template);
    if (project.plan.template !== "static-site") {
      throw new PublishError("NEEDS_SERVER", `This ${template.title.toLowerCase()} runs its own server with a database, which static hosting cannot run. Keep it on this computer (reach it from your phone under Settings → Reach Atlas), or publish the repository and host it on a server you control.`);
    }
    const decision = this.#policy("deploy.remote", "deploying");
    if (this.runCheck) {
      const built = await this.runCheck(template.commands.build, project.workspace, { timeoutMs: 300_000 });
      if (built.exitCode !== 0) throw new PublishError("BUILD_FAILED", "The site did not build; ask Atlas to fix it first.");
    }
    const files = collectStaticFiles(project.workspace);
    const vercel = await this.#vercel();
    const plan = (() => { try { return vercel.planStaticDeployment({ name: deploymentName(project.name), files, target }); } catch (error) { throw new PublishError(error.code ?? "PLAN_FAILED", error.message); } })();
    const commit = (await git(project.workspace, ["rev-parse", "HEAD"])).stdout.trim();
    // Adaptive autonomy (kernel/autonomy.mjs): production is level 4, so it is
    // approved and confirmed a second time even where deploys are allowed.
    const production = target === "production";
    if (decision === "allow" && !production) return this.#deploy(project, plan, commit, { approval: null });
    const approval = this.approvals.create({ capability: "deploy.remote", summary: `Deploy "${project.name}" to Vercel (${target}, ${files.length} files)`, actionDigest: publishDigest({ projectId, remote: plan.digest, commit }), riskLevel: production ? 4 : 3 });
    this.genesis.store.recordPublishRequest(projectId, { approvalId: approval.id, remote: plan.digest, commit, kind: "deploy", plan });
    return { status: "awaiting-approval", approvalId: approval.id, plan: { target: plan.target, notes: plan.notes, files: files.length }, commit };
  }

  async #deploy(project, plan, commit, { approval }) {
    this.genesis.advance(project.id, "publishing", { reason: `Deploying to Vercel (${plan.after.target}).`, evidence: { kind: "deploy", target: plan.target, commit, approval, plan: plan.digest } });
    let result;
    try {
      result = await (await this.#vercel()).applyStaticDeployment({ plan, files: collectStaticFiles(project.workspace) });
    } catch (error) {
      this.genesis.advance(project.id, "ready", { reason: `Deploying failed: ${error.message}`.slice(0, 900), evidence: { kind: "deploy-failed", message: String(error.message).slice(0, 2000) } });
      return { status: "failed", message: error.message };
    }
    if (!result.verified) {
      this.genesis.advance(project.id, "ready", { reason: `Vercel reported the deployment as ${result.observed.state}.`, evidence: { kind: "deploy-failed", observed: result.observed } });
      return { status: "failed", message: `Deployment ${result.observed.state}.` };
    }
    this.genesis.advance(project.id, "published", { reason: `Deployed: ${result.observed.url}`, evidence: { kind: "deployed", deployment: result.observed, commit, approval }, patch: {} });
    return { status: "deployed", deployment: result.observed, commit };
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
    const approval = this.approvals.create({ capability: "publish.remote", summary: `Publish "${project.name}" (commit ${commit.slice(0, 8)}) to ${destination}`, actionDigest: digest, riskLevel: 3 });
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
      return { status: "stale", message: "The project changed after you approved this; ask again." };
    }
    if (!["ready", "published"].includes(project.state)) return { status: "stale", message: `The project is ${project.state}; ask again when it is ready.` };
    if (request.kind === "repository") return this.#createRepository(project, request.plan, commit, { approval: approval.id });
    if (request.kind === "deploy") return this.#deploy(project, request.plan, commit, { approval: approval.id });
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
