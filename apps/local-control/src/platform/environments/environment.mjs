/**
 * An Environment is a persistent, snapshot-able workspace that Atlas works
 * in: a project can be started, stopped, and resumed later (on this machine
 * or, later, in the cloud) with its files, state and checkpoints intact.
 *
 * The contract every implementation provides (ENGINEERING-PLAN-2026 §3.1):
 *
 *   describe()                 → { kind, id, folder?, capabilities[], isolation }
 *   exec(argv, { timeoutMs })  → { exitCode, stdout, stderr, timedOut? }  argv only, never a shell
 *   files.read/write/list      → paths confined to the environment
 *   snapshot({ manifest })     → Snapshot { commit, treeDigest, manifest, manifestDigest, ... }
 *   restore(snapshot, { folder }) → a new Environment of the same kind, verified
 *                                against the snapshot's digests (fails closed)
 *   destroy()                  → removes the working copy; snapshots are kept
 *
 * `create` is a static factory on each implementation, because what it needs
 * (a local folder, a sandbox id) differs per kind.
 *
 * Implementations:
 * - `local` — LocalEnvironment (local.mjs): a git workspace on this machine;
 *   a snapshot is a git commit kept in a per-environment snapshot repository
 *   plus a sha256 digest of the tree and a manifest.
 * - `cloudflare-sandbox` — CloudflareSandboxEnvironment (cloudflare.mjs): a
 *   Cloudflare Sandbox behind the hosted Worker's broker, addressed by a
 *   stable id. It resolves only when configured (ATLAS_CLOUD_SANDBOX_URL and
 *   the ATLAS_CLOUD_SANDBOX_TOKEN credential); otherwise asking for it returns
 *   `UNAVAILABLE` rather than pretending. See CLOUD_SEAM.
 */
import { CloudflareSandboxEnvironment, cloudSandboxConfigured } from "./cloudflare.mjs";
// cloudflare.mjs imports this module too. Neither uses the other's bindings at
// load time (only inside functions), so the cycle is safe in either load order.

export const ENVIRONMENT_OPERATIONS = Object.freeze(["describe", "exec", "snapshot", "restore", "destroy"]);

/** Capabilities an environment may declare; Atlas only routes work an environment says it can do. */
export const ENVIRONMENT_CAPABILITIES = Object.freeze(["files", "exec", "snapshot", "restore", "git", "terminal", "browser", "dev-server", "ffmpeg", "blender", "godot", "gpu"]);

export class EnvironmentError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "EnvironmentError";
    this.code = code;
    this.details = details;
  }
}

/** Throws unless `environment` implements the whole contract (used when a provider is plugged in). */
export function assertEnvironment(environment) {
  const missing = ENVIRONMENT_OPERATIONS.filter((name) => typeof environment?.[name] !== "function");
  if (!environment?.files || ["read", "write", "list"].some((name) => typeof environment.files[name] !== "function")) missing.push("files");
  if (missing.length) throw new EnvironmentError("INCOMPLETE", `The environment does not implement: ${missing.join(", ")}.`);
  const description = environment.describe();
  const unknown = (description.capabilities ?? []).filter((capability) => !ENVIRONMENT_CAPABILITIES.includes(capability));
  if (unknown.length) throw new EnvironmentError("UNKNOWN_CAPABILITY", `Unknown capabilities: ${unknown.join(", ")}.`);
  return environment;
}

/**
 * The cloud implementation (cloudflare.mjs) maps the contract onto Cloudflare
 * Sandboxes through the hosted Worker's broker (apps/web/app/api/sandbox):
 *   create   → a sandbox addressed by a stable, tenant-scoped id (sleeps when idle)
 *   exec     → a command in the sandbox (argv, bounded by time and output, network off by default)
 *   files    → the sandbox filesystem, confined to the workspace
 *   snapshot → a Sandbox SDK directory backup in R2 plus the same treeDigest/manifestDigest
 *              as local, so a local snapshot can be restored in the cloud and the reverse
 *   restore  → into a fresh sandbox, digest recomputed, fail closed on mismatch
 *   destroy  → delete the sandbox (snapshots are kept)
 * Credentials stay in the vault or the environment, never in prompts or logs.
 * It is live only when the owner has deployed the Worker with the sandbox
 * build (Workers Paid plan); until then the broker answers UNAVAILABLE.
 */
export const CLOUD_SEAM = Object.freeze({ kind: "cloudflare-sandbox", status: "implemented-needs-deploy" });

/**
 * The provider registry: only kinds with a real implementation resolve.
 * `cloudflare-sandbox` resolves to CloudflareSandboxEnvironment when it is
 * configured in `env` (or a vault can supply the token), and is UNAVAILABLE otherwise.
 */
export function resolveEnvironmentKind(kind, providers, { env = process.env, vault = null } = {}) {
  const provider = providers?.[kind];
  if (provider) return provider;
  if (kind === CLOUD_SEAM.kind) {
    if (cloudSandboxConfigured(env, { vault })) return CloudflareSandboxEnvironment;
    throw new EnvironmentError("UNAVAILABLE", "Cloud environments (Cloudflare Sandboxes) are not configured: set ATLAS_CLOUD_SANDBOX_URL and the ATLAS_CLOUD_SANDBOX_TOKEN credential, and deploy the Worker with the sandbox build (needs the Workers Paid plan). Use a local environment until then.");
  }
  throw new EnvironmentError("UNKNOWN_KIND", `There is no environment of kind ${kind}.`);
}

/** JSON with sorted object keys, so a digest of the same value is always the same. */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().filter((key) => value[key] !== undefined).map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value ?? null);
}
