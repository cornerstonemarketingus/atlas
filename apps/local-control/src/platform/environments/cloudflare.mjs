import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { git } from "../engineering/git.mjs";
import { commitWorkspace } from "../genesis/workspace.mjs";
import { EnvironmentError } from "./environment.mjs";
import { LocalEnvironment, contentSha256, digestTreeEntries, manifestDigest, treeDigest } from "./local.mjs";

/**
 * CloudflareSandboxEnvironment: the Environment contract (environment.mjs)
 * on a Cloudflare Sandbox, through the broker in the hosted Worker
 * (apps/web/app/api/sandbox/broker.mjs) over HTTPS.
 *
 * - Configured by ATLAS_CLOUD_SANDBOX_URL (the Worker's origin; https, or
 *   http on loopback for tests) and a bearer token: ATLAS_CLOUD_SANDBOX_TOKEN
 *   from the environment, or the same name in the credential vault. The token
 *   is the Worker's operator token. It is held in a private field and never
 *   appears in describe(), a snapshot, an error message or its details.
 * - Unconfigured, or when the broker answers 503 (the Worker was deployed
 *   without the sandbox build: no Workers Paid plan yet), every call fails
 *   with UNAVAILABLE and the broker's reason. Atlas never falls back from the
 *   sandbox to running on the host.
 * - Snapshots use the same tree digest as LocalEnvironment
 *   (digestTreeEntries): the broker returns per-file entries and the digest is
 *   computed here. A restore always goes into a fresh sandbox; the restored
 *   tree's digest must equal the snapshot's or the fresh sandbox is destroyed
 *   and the restore fails closed (DIGEST_MISMATCH).
 * - migrateLocalSnapshotToCloud / migrateCloudSnapshotToLocal move a
 *   snapshot between kinds, verified against the same digests at both ends.
 */

export const CLOUD_KIND = "cloudflare-sandbox";
export const URL_VARIABLE = "ATLAS_CLOUD_SANDBOX_URL";
export const TOKEN_NAME = "ATLAS_CLOUD_SANDBOX_TOKEN";
const CLOUD_ID = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/u;
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const EXEC_SLACK_MS = 30_000;
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

const execFileAsync = promisify(execFile);

/** The broker origin from the environment, or null when it is unset or unsafe. */
export function cloudSandboxUrl(env = process.env) {
  const raw = env?.[URL_VARIABLE];
  if (!raw) return null;
  let url;
  try { url = new URL(String(raw)); } catch { return null; }
  if (url.username || url.password) return null;
  if (url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK.has(url.hostname))) return url.origin;
  return null;
}

/** Whether `cloudflare-sandbox` can resolve: a broker URL, and a token in the environment or a vault to read it from. */
export function cloudSandboxConfigured(env = process.env, { vault = null } = {}) {
  return Boolean(cloudSandboxUrl(env) && (env?.[TOKEN_NAME] || vault));
}

function unavailable(reason) {
  return new EnvironmentError("UNAVAILABLE", reason ?? "Cloud environments (Cloudflare Sandboxes) are not configured: set ATLAS_CLOUD_SANDBOX_URL and the ATLAS_CLOUD_SANDBOX_TOKEN credential, and deploy the Worker with the sandbox build (Workers Paid plan).");
}

/** Atlas ids (LocalEnvironment: letters, digits, _ and -) → a DNS-safe broker id. */
export function cloudId(id) {
  const mapped = String(id ?? "").toLowerCase().replaceAll("_", "-");
  if (!CLOUD_ID.test(mapped)) throw new EnvironmentError("BAD_ID", "A cloud environment id is 1-40 letters, digits, _ and -, not starting or ending with - or _.");
  return mapped;
}

/** The HTTPS client for the broker. The token is private and is scrubbed from anything the broker sends back. */
export class BrokerClient {
  #token;

  constructor({ url, token, fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS }) {
    if (!url) throw unavailable();
    if (!token) throw unavailable("The cloud sandbox token (ATLAS_CLOUD_SANDBOX_TOKEN) is not set in the environment or the credential vault.");
    this.url = url;
    this.#token = String(token);
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  #scrub(text) {
    return String(text ?? "").split(this.#token).join("[redacted]").slice(0, 500);
  }

  async request(method, path, { body, timeoutMs = this.timeoutMs } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await this.fetchImpl(`${this.url}/api/sandbox/${path}`, {
        method,
        headers: { authorization: `Bearer ${this.#token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
        redirect: "error",
      });
    } catch (error) {
      if (controller.signal.aborted) throw new EnvironmentError("TIMEOUT", `The cloud sandbox broker did not answer within ${timeoutMs} ms.`, { path });
      throw new EnvironmentError("UNAVAILABLE", `The cloud sandbox broker could not be reached: ${this.#scrub(error?.cause?.code ?? error?.name ?? "network error")}.`, { path });
    } finally {
      clearTimeout(timer);
    }
    let payload = null;
    try { payload = await response.json(); } catch { payload = null; }
    if (response.ok) return payload;
    const code = response.status === 401 || response.status === 403 ? "UNAUTHORIZED"
      : response.status === 503 ? "UNAVAILABLE"
        : typeof payload?.code === "string" && /^[A-Z_]{2,40}$/u.test(payload.code) ? payload.code : "BROKER_ERROR";
    const message = this.#scrub(payload?.message ?? `The cloud sandbox broker answered ${response.status}.`);
    throw new EnvironmentError(code, message, { status: response.status, path });
  }
}

async function tokenFrom(env, vault) {
  if (env?.[TOKEN_NAME]) return env[TOKEN_NAME];
  if (!vault) return null;
  try { return await vault.get(TOKEN_NAME); } catch { return null; }
}

export class CloudflareSandboxEnvironment {
  #client;
  #description;

  /** Use create(); the constructor takes an already-described sandbox. */
  constructor({ id, client, description, now = () => new Date() }) {
    this.id = cloudId(id);
    this.#client = client;
    this.#description = description ?? {};
    this.now = now;
    this.files = {
      read: async (path) => {
        const answer = await this.#client.request("GET", `${this.id}/files?path=${encodeURIComponent(path)}`);
        return Buffer.from(answer.contentBase64, "base64");
      },
      write: async (path, content, { executable } = {}) => {
        await this.#client.request("PUT", `${this.id}/files`, { body: { path: String(path), contentBase64: Buffer.from(content).toString("base64"), executable } });
      },
      list: async () => (await this.tree()).entries.map((entry) => entry.path),
    };
  }

  /** A broker client from the environment and vault; UNAVAILABLE when cloud environments are not configured. */
  static async client({ env = process.env, vault = null, fetchImpl, timeoutMs } = {}) {
    const url = cloudSandboxUrl(env);
    if (!url) throw unavailable();
    return new BrokerClient({ url, token: await tokenFrom(env, vault), fetchImpl, timeoutMs });
  }

  /**
   * Creates the sandbox (or reattaches to it: create is idempotent unless
   * `fresh`). Network access is off unless `internet: true`.
   */
  static async create({ id, env = process.env, vault = null, fetchImpl, timeoutMs, client = null, internet = false, fresh = false, now } = {}) {
    const broker = client ?? await CloudflareSandboxEnvironment.client({ env, vault, fetchImpl, timeoutMs });
    const mapped = cloudId(id);
    const description = await broker.request("POST", mapped, { body: { internet: internet === true, fresh: fresh === true } });
    return new CloudflareSandboxEnvironment({ id: mapped, client: broker, description, now });
  }

  describe() {
    return {
      kind: CLOUD_KIND,
      id: this.id,
      capabilities: ["files", "exec", "snapshot", "restore", "git"],
      isolation: "container",
      network: this.#description.internet === true ? "internet" : "off",
      broker: this.#client.url,
    };
  }

  async exec(argv, { timeoutMs = 600_000, maxOutputBytes } = {}) {
    if (!Array.isArray(argv) || !argv.length || argv.some((part) => typeof part !== "string")) throw new EnvironmentError("BAD_COMMAND", "exec takes an argv array of strings.");
    return this.#client.request("POST", `${this.id}/exec`, { body: { argv, timeoutMs, maxOutputBytes }, timeoutMs: timeoutMs + EXEC_SLACK_MS });
  }

  /** The tree entries and their digest (the scheme LocalEnvironment uses). */
  async tree() {
    const { entries } = await this.#client.request("GET", `${this.id}/tree`, { timeoutMs: 180_000 });
    return { entries, ...digestTreeEntries(entries) };
  }

  async snapshot({ manifest = {}, name } = {}) {
    const { backup, entries } = await this.#client.request("POST", `${this.id}/snapshot`, { body: { name }, timeoutMs: 15 * 60_000 });
    const tree = digestTreeEntries(entries);
    const body = { ...manifest, environment: { kind: CLOUD_KIND, id: this.id } };
    return {
      id: `snap_${backup.id}`,
      kind: CLOUD_KIND,
      environmentId: this.id,
      backup,
      treeDigest: tree.digest,
      files: tree.files,
      manifest: body,
      manifestDigest: manifestDigest(body),
      createdAt: this.now().toISOString(),
    };
  }

  /**
   * Restores a cloud snapshot into the fresh sandbox `id` and verifies it.
   * Throws (MANIFEST_MISMATCH, DIGEST_MISMATCH, EXISTS, BACKUP_INTEGRITY, ...)
   * and leaves no sandbox behind when verification fails.
   */
  async restore(snapshot, { id } = {}) {
    if (snapshot?.kind === "local") throw new EnvironmentError("WRONG_KIND", "This is a local snapshot; use migrateLocalSnapshotToCloud to restore it in the cloud.");
    if (snapshot?.kind !== CLOUD_KIND || !snapshot.backup) throw new EnvironmentError("BAD_SNAPSHOT", "The snapshot has no cloud backup.");
    if (manifestDigest(snapshot.manifest ?? {}) !== snapshot.manifestDigest) {
      throw new EnvironmentError("MANIFEST_MISMATCH", "The snapshot manifest does not match its recorded digest; refusing to restore.", { snapshot: snapshot.id });
    }
    const target = cloudId(id ?? `${this.id.slice(0, 24)}-r${randomBytes(4).toString("hex")}`);
    const { entries } = await this.#client.request("POST", `${target}/restore`, { body: { backup: snapshot.backup }, timeoutMs: 15 * 60_000 });
    const restored = new CloudflareSandboxEnvironment({ id: target, client: this.#client, description: { internet: false }, now: this.now });
    let tree;
    try { tree = digestTreeEntries(entries); } catch (error) { await restored.destroy().catch(() => {}); throw error; }
    if (tree.digest !== snapshot.treeDigest) {
      await restored.destroy().catch(() => {});
      throw new EnvironmentError("DIGEST_MISMATCH", "The restored files do not match the snapshot's digest; refusing to restore.", { snapshot: snapshot.id, expected: snapshot.treeDigest, actual: tree.digest });
    }
    return {
      environment: restored,
      receipt: { snapshot: snapshot.id, treeDigest: tree.digest, manifestDigest: snapshot.manifestDigest, files: tree.files, sandbox: target, verified: true },
    };
  }

  /** Removes the sandbox and its container. Snapshots (in R2) are kept. */
  async destroy() {
    const answer = await this.#client.request("DELETE", this.id);
    return { destroyed: Boolean(answer?.destroyed), sandbox: this.id, snapshotsKept: true };
  }

  /** A preview URL for a port (the deployment needs a preview domain). */
  async preview(port) {
    return this.#client.request("POST", `${this.id}/preview`, { body: { port } });
  }
}

function refuseUnsupported(entries) {
  const odd = entries.find((entry) => entry.mode === "120000" || entry.mode === "160000");
  if (odd) throw new EnvironmentError("UNSUPPORTED", `Migrating symlinks and submodules is not supported yet (${odd.path}).`);
}

/**
 * Puts a local snapshot into a fresh cloud sandbox. The files are read from
 * the local snapshot repository and checked against the snapshot's tree
 * digest before anything is uploaded; the cloud tree is checked against it
 * again after. Any mismatch destroys the sandbox and fails closed.
 */
export async function migrateLocalSnapshotToCloud({ source, snapshot, id, client = null, env = process.env, vault = null, fetchImpl } = {}) {
  if (!(source instanceof LocalEnvironment) || snapshot?.kind !== "local") throw new EnvironmentError("WRONG_KIND", "Migrating to the cloud takes a local environment and one of its snapshots.");
  if (manifestDigest(snapshot.manifest ?? {}) !== snapshot.manifestDigest) throw new EnvironmentError("MANIFEST_MISMATCH", "The snapshot manifest does not match its recorded digest; refusing to migrate.");
  if (!/^[0-9a-f]{40,64}$/u.test(String(snapshot.commit)) || !existsSync(join(source.store, "HEAD"))) throw new EnvironmentError("NO_SNAPSHOT_STORE", "The local snapshot repository or commit is missing.");
  const listing = (await git(source.store, ["ls-tree", "-r", "-z", "--full-tree", snapshot.commit])).stdout.split("\0").filter(Boolean);
  const files = [];
  for (const line of listing) {
    const tab = line.indexOf("\t");
    const [mode, type, oid] = line.slice(0, tab).split(" ");
    const path = line.slice(tab + 1);
    if (type !== "blob" || mode === "120000") throw new EnvironmentError("UNSUPPORTED", `Migrating symlinks and submodules is not supported yet (${path}).`);
    // Git does not re-hash local objects, so the content is checked against the digest below.
    const { stdout } = await execFileAsync("git", ["-C", source.store, "cat-file", "blob", oid], { encoding: "buffer", maxBuffer: 1 << 30 });
    files.push({ mode, path, content: stdout });
  }
  const local = digestTreeEntries(files.map(({ mode, path, content }) => ({ mode, path, sha256: contentSha256(content) })));
  if (local.digest !== snapshot.treeDigest) throw new EnvironmentError("DIGEST_MISMATCH", "The local snapshot's files do not match its digest; refusing to migrate.", { expected: snapshot.treeDigest, actual: local.digest });

  const environment = await CloudflareSandboxEnvironment.create({ id: id ?? source.id, client, env, vault, fetchImpl, fresh: true });
  try {
    for (const file of files) await environment.files.write(file.path, file.content, { executable: file.mode === "100755" });
    const tree = await environment.tree();
    if (tree.digest !== snapshot.treeDigest) throw new EnvironmentError("DIGEST_MISMATCH", "The cloud copy does not match the snapshot's digest; refusing to migrate.", { expected: snapshot.treeDigest, actual: tree.digest });
    return { environment, receipt: { snapshot: snapshot.id, treeDigest: tree.digest, manifestDigest: snapshot.manifestDigest, files: tree.files, sandbox: environment.id, verified: true } };
  } catch (error) {
    await environment.destroy().catch(() => {});
    throw error;
  }
}

function inside(parent, child) {
  const root = resolve(parent);
  const target = resolve(child);
  return target !== root && target.startsWith(root.endsWith(sep) ? root : root + sep);
}

/**
 * Recreates a cloud snapshot as a local git workspace in a fresh `folder`:
 * the snapshot is restored (and verified) in a temporary sandbox, its files
 * are downloaded and committed, and the local tree digest must equal the
 * snapshot's. The temporary sandbox is always destroyed; on a mismatch the
 * folder is removed too.
 */
export async function migrateCloudSnapshotToLocal({ cloud, snapshot, folder, root, snapshotsRoot, runCheck = null }) {
  if (!(cloud instanceof CloudflareSandboxEnvironment)) throw new EnvironmentError("WRONG_KIND", "Migrating to local takes a cloud environment.");
  const target = resolve(folder);
  if (!inside(root, target)) throw new EnvironmentError("UNSAFE_PATH", "The folder must be inside the environment root.");
  if (existsSync(target) && readdirSync(target).length) throw new EnvironmentError("EXISTS", `${target} is not empty; migration needs a fresh folder.`);
  const { environment: temporary } = await cloud.restore(snapshot);
  try {
    const { entries } = await temporary.tree();
    refuseUnsupported(entries);
    mkdirSync(target, { recursive: true });
    for (const entry of entries) {
      const path = join(target, entry.path);
      if (!inside(target, path) || entry.path.split("/")[0] === ".git") throw new EnvironmentError("UNSAFE_PATH", `${entry.path} is outside the workspace.`);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, await temporary.files.read(entry.path));
      chmodSync(path, entry.mode === "100755" ? 0o755 : 0o644);
    }
    await git(target, ["init", "-q", "-b", "main"]);
    await git(target, ["config", "core.autocrlf", "false"]);
    await commitWorkspace(target, `Atlas migration of ${snapshot.id}`);
    const environment = await LocalEnvironment.create({ id: snapshot.environmentId, folder: target, root, snapshotsRoot, runCheck });
    const head = (await git(target, ["rev-parse", "HEAD"])).stdout.trim();
    const tree = await treeDigest(target, head);
    if (tree.digest !== snapshot.treeDigest) throw new EnvironmentError("DIGEST_MISMATCH", "The local copy does not match the snapshot's digest; refusing to migrate.", { expected: snapshot.treeDigest, actual: tree.digest });
    return { environment, receipt: { snapshot: snapshot.id, commit: head, treeDigest: tree.digest, manifestDigest: snapshot.manifestDigest, files: tree.files, folder: target, verified: true } };
  } catch (error) {
    rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    throw error;
  } finally {
    await temporary.destroy().catch(() => {});
  }
}
