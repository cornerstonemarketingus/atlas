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
 * - `cloudflare-sandbox` — the seam for the cloud implementation (persistent
 *   Cloudflare Sandboxes addressed by a stable id). Not implemented: asking
 *   for it returns `UNAVAILABLE` rather than pretending. See CLOUD_SEAM.
 */

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
 * The seam for the cloud implementation. A future `CloudflareSandboxEnvironment`
 * maps the contract onto Cloudflare Sandboxes:
 *   create   → a sandbox addressed by a stable id (sleeps when idle, wakes on request)
 *   exec     → a command in the sandbox (argv, bounded by time and output)
 *   files    → the sandbox filesystem API
 *   snapshot → a sandbox snapshot plus the same treeDigest/manifestDigest as local,
 *              so a local snapshot can be restored in the cloud and the reverse
 *   restore  → restore the sandbox snapshot, recompute the digest, fail closed on mismatch
 *   destroy  → delete the sandbox
 * Credentials are injected by the hosted side, never passed through prompts.
 * Until it exists, `resolveEnvironmentKind("cloudflare-sandbox")` refuses.
 */
export const CLOUD_SEAM = Object.freeze({ kind: "cloudflare-sandbox", status: "interface-only" });

/** The provider registry: only kinds with a real implementation resolve. */
export function resolveEnvironmentKind(kind, providers) {
  const provider = providers?.[kind];
  if (provider) return provider;
  if (kind === CLOUD_SEAM.kind) throw new EnvironmentError("UNAVAILABLE", "Cloud environments (Cloudflare Sandboxes) are not available yet; use a local environment.");
  throw new EnvironmentError("UNKNOWN_KIND", `There is no environment of kind ${kind}.`);
}

/** JSON with sorted object keys, so a digest of the same value is always the same. */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().filter((key) => value[key] !== undefined).map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value ?? null);
}
