import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { git } from "../engineering/git.mjs";
import { commitWorkspace } from "../genesis/workspace.mjs";
import { EnvironmentError, canonicalJson } from "./environment.mjs";

/**
 * LocalEnvironment: a git workspace on this machine (a Genesis project
 * folder) behind the Environment contract.
 *
 * - snapshot: everything tracked is committed, the commit is copied into a
 *   per-environment snapshot repository (`<snapshotsRoot>/<id>.git`, ref
 *   `refs/atlas/snapshots/<n>`), and two digests are recorded: a sha256 over
 *   the tree as it is on disk (every tracked path, its mode and the sha256 of
 *   its content) and a sha256 of the manifest (plan state, last verified
 *   check, pending side-effect intents) in canonical JSON. The snapshot
 *   repository outlives the workspace, so deleting the folder loses nothing
 *   that was snapshotted.
 * - restore: the snapshot commit is checked out into a fresh, empty folder,
 *   the tree digest is recomputed from the files actually written, and both
 *   digests must match the record. Git does not re-hash objects it copies
 *   locally, so a tampered object in the snapshot repository would otherwise
 *   be restored silently; on any mismatch the fresh folder is removed and
 *   restore fails closed.
 * - exec runs argv through the injected shell-free runner (the daemon's
 *   runCheck); it is not a sandbox: commands run as the owner with the
 *   workspace as their working directory, exactly as Genesis checks do today.
 *
 * Ignored files (node_modules/, dist/, data/) are not part of a snapshot;
 * verification reinstalls and rebuilds them.
 */

const ID = /^[A-Za-z0-9_-]{1,100}$/u;
const sha256 = (data) => createHash("sha256").update(data).digest("hex");

function inside(parent, child) {
  const root = resolve(parent);
  const target = resolve(child);
  return target === root || target.startsWith(root.endsWith(sep) ? root : root + sep);
}

/** sha256 of the canonical manifest JSON. */
export function manifestDigest(manifest) {
  return `sha256:${sha256(canonicalJson(manifest))}`;
}

const TREE_MODES = new Set(["100644", "100755", "120000", "160000"]);
const byPath = (a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

/**
 * The tree-digest scheme, shared by every environment kind so a snapshot can
 * be verified wherever it is restored (a local folder or a Cloudflare
 * Sandbox, see cloudflare.mjs): entries sorted by path, each
 * `<git mode> <path>\0<sha256 of the content>\n`, hashed with sha256.
 * The content is the file's bytes, the text `symlink <target>` for a
 * symlink, or `submodule <oid>` for a gitlink (see contentSha256).
 * A malformed or duplicate entry throws BAD_TREE instead of producing a digest.
 *
 * @param {{ mode: string, path: string, sha256: string }[]} entries
 */
export function digestTreeEntries(entries) {
  if (!Array.isArray(entries)) throw new EnvironmentError("BAD_TREE", "A tree is a list of entries.");
  const seen = new Set();
  for (const entry of entries) {
    const path = entry?.path;
    if (!TREE_MODES.has(entry?.mode) || typeof path !== "string" || !path || path.includes("\0") || path.startsWith("/")
      || path.split("/").some((part) => part === "" || part === "." || part === "..")
      || !/^[0-9a-f]{64}$/u.test(String(entry.sha256)) || seen.has(path)) {
      throw new EnvironmentError("BAD_TREE", "The tree has a malformed or duplicate entry.", { path: typeof path === "string" ? path.slice(0, 200) : null });
    }
    seen.add(path);
  }
  const hash = createHash("sha256");
  const sorted = [...entries].sort(byPath);
  for (const entry of sorted) hash.update(`${entry.mode} ${entry.path}\0${entry.sha256}\n`);
  return { digest: `sha256:${hash.digest("hex")}`, files: sorted.length };
}

/** sha256 (hex) of one entry's digest content: a file's bytes, `symlink <target>` or `submodule <oid>`. */
export function contentSha256(content) {
  return sha256(content);
}

/**
 * The digest of `commit`'s tree as it is on disk in `folder`: for every
 * tracked path (from the commit, not from the working copy's index) its git
 * mode, its path and the sha256 of the bytes on disk. A missing or replaced
 * file changes the digest.
 */
export async function treeDigest(folder, commit) {
  const listing = (await git(folder, ["ls-tree", "-r", "-z", "--full-tree", commit])).stdout.split("\0").filter(Boolean);
  const entries = listing.map((line) => {
    const tab = line.indexOf("\t");
    const [mode, type, oid] = line.slice(0, tab).split(" ");
    const path = line.slice(tab + 1);
    let content;
    if (type === "commit") content = `submodule ${oid}`;
    else {
      const absolute = join(folder, path);
      try {
        const stat = lstatSync(absolute);
        content = stat.isSymbolicLink() ? `symlink ${readlinkSync(absolute)}` : readFileSync(absolute);
      } catch { content = "\0missing"; }
    }
    return { mode, path, sha256: sha256(content) };
  });
  return digestTreeEntries(entries);
}

export class LocalEnvironment {
  /**
   * @param {{ id: string, folder: string, root: string, snapshotsRoot: string,
   *   runCheck?: (argv: string[], cwd: string, options?: object) => Promise<{ exitCode: number, stdout: string, stderr: string }>,
   *   now?: () => Date }} options
   */
  constructor({ id, folder, root, snapshotsRoot, runCheck = null, now = () => new Date() }) {
    if (!ID.test(String(id))) throw new EnvironmentError("BAD_ID", "An environment id is letters, digits, _ and - only.");
    if (!inside(root, folder) || resolve(root) === resolve(folder)) throw new EnvironmentError("UNSAFE_PATH", "The environment folder must be inside its root.");
    this.id = id;
    this.folder = resolve(folder);
    this.root = resolve(root);
    this.snapshotsRoot = resolve(snapshotsRoot);
    this.runCheck = runCheck;
    this.now = now;
    this.files = {
      read: (path) => readFileSync(this.#path(path)),
      write: (path, content) => { const target = this.#path(path); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, content); },
      list: async () => (await git(this.folder, ["ls-files", "-z", "-co", "--exclude-standard"])).stdout.split("\0").filter(Boolean).sort(),
    };
  }

  /** Wraps an existing git workspace (Genesis creates it from a template). */
  static async create(options) {
    const environment = new LocalEnvironment(options);
    if (!existsSync(join(environment.folder, ".git"))) throw new EnvironmentError("NOT_A_WORKSPACE", `${environment.folder} is not a git workspace.`);
    return environment;
  }

  get store() { return join(this.snapshotsRoot, `${this.id}.git`); }

  #path(relativePath) {
    const target = resolve(this.folder, String(relativePath));
    if (!inside(this.folder, target) || target === this.folder || target.split(sep).includes(".git")) throw new EnvironmentError("UNSAFE_PATH", `${relativePath} is outside the environment.`);
    // A symlink inside the workspace must not lead outside it.
    let existing = target;
    while (!existsSync(existing)) existing = dirname(existing);
    if (!inside(realpathSync(this.folder), realpathSync(existing))) throw new EnvironmentError("UNSAFE_PATH", `${relativePath} leads outside the environment.`);
    return target;
  }

  describe() {
    return {
      kind: "local",
      id: this.id,
      folder: this.folder,
      capabilities: ["files", "exec", "snapshot", "restore", "git"],
      isolation: "workspace-folder",
      snapshotStore: this.store,
    };
  }

  async exec(argv, { timeoutMs = 600_000 } = {}) {
    if (!Array.isArray(argv) || !argv.length || argv.some((part) => typeof part !== "string")) throw new EnvironmentError("BAD_COMMAND", "exec takes an argv array of strings.");
    if (!this.runCheck) throw new EnvironmentError("NO_RUNNER", "This environment has no command runner.");
    return this.runCheck(argv, this.folder, { timeoutMs });
  }

  async #ensureStore() {
    if (existsSync(join(this.store, "HEAD"))) return;
    mkdirSync(this.snapshotsRoot, { recursive: true });
    await git(this.snapshotsRoot, ["init", "-q", "--bare", this.store]);
  }

  /** Commits the workspace, copies the commit into the snapshot repository and records both digests. */
  async snapshot({ manifest = {}, message = "Atlas snapshot" } = {}) {
    if (!existsSync(join(this.folder, ".git"))) throw new EnvironmentError("NOT_A_WORKSPACE", `${this.folder} is not a git workspace.`);
    // Git must store the bytes that are on disk, so the tree digest (taken
    // from disk) can be reproduced by a checkout. A global core.autocrlf
    // (the default on Windows) would otherwise rewrite line endings.
    await git(this.folder, ["config", "core.autocrlf", "false"]);
    // Files committed while autocrlf was on (for example template files
    // copied from a CRLF checkout) were stored converted, and git trusts its
    // index for files it thinks are unchanged. Re-read every tracked file so
    // the commit holds exactly the bytes on disk.
    await git(this.folder, ["add", "--renormalize", "."]);
    await commitWorkspace(this.folder, message);
    const commit = (await git(this.folder, ["rev-parse", "HEAD"])).stdout.trim();
    await this.#ensureStore();
    const existing = (await git(this.store, ["for-each-ref", "--format=%(refname)", "refs/atlas/snapshots/"])).stdout.split("\n").filter(Boolean);
    const seq = existing.reduce((max, ref) => Math.max(max, Number(ref.split("/").at(-1)) || 0), 0) + 1;
    await git(this.folder, ["push", "-q", "--no-verify", this.store, `${commit}:refs/atlas/snapshots/${seq}`]);
    const tree = await treeDigest(this.folder, commit);
    const body = { ...manifest, environment: { kind: "local", id: this.id } };
    return {
      id: `snap_${this.id.slice(-12)}_${seq}`,
      seq,
      kind: "local",
      environmentId: this.id,
      commit,
      treeDigest: tree.digest,
      files: tree.files,
      manifest: body,
      manifestDigest: manifestDigest(body),
      createdAt: this.now().toISOString(),
    };
  }

  /**
   * Recreates the workspace from `snapshot` in `folder` (fresh: absent or
   * empty) and verifies it. Returns the new LocalEnvironment and a receipt;
   * throws EnvironmentError (MANIFEST_MISMATCH, DIGEST_MISMATCH, ...) and
   * leaves nothing behind when verification fails.
   */
  async restore(snapshot, { folder }) {
    if (!snapshot?.commit || !/^[0-9a-f]{40,64}$/u.test(snapshot.commit)) throw new EnvironmentError("BAD_SNAPSHOT", "The snapshot has no commit.");
    if (manifestDigest(snapshot.manifest ?? {}) !== snapshot.manifestDigest) {
      throw new EnvironmentError("MANIFEST_MISMATCH", "The snapshot manifest does not match its recorded digest; refusing to restore.", { snapshot: snapshot.id });
    }
    if (!existsSync(join(this.store, "HEAD"))) throw new EnvironmentError("NO_SNAPSHOT_STORE", "The snapshot repository is missing.");
    const target = resolve(folder);
    if (!inside(this.root, target) || target === this.root) throw new EnvironmentError("UNSAFE_PATH", "The restore folder must be inside the environment root.");
    if (existsSync(target) && readdirSync(target).length) throw new EnvironmentError("EXISTS", `${target} is not empty; restore needs a fresh folder.`);
    const restored = new LocalEnvironment({ id: this.id, folder: target, root: this.root, snapshotsRoot: this.snapshotsRoot, runCheck: this.runCheck, now: this.now });
    try {
      mkdirSync(dirname(target), { recursive: true });
      // --no-hardlinks: the restored workspace never shares files with the snapshot repository.
      // core.autocrlf=false: check out exactly the stored bytes, whatever the global git config says.
      await git(dirname(target), ["clone", "-q", "--no-checkout", "--no-hardlinks", "--config", "core.autocrlf=false", this.store, target]);
      await git(target, ["-c", "advice.detachedHead=false", "checkout", "-q", "-B", "main", snapshot.commit]);
      await git(target, ["remote", "remove", "origin"]);
      const head = (await git(target, ["rev-parse", "HEAD"])).stdout.trim();
      if (head !== snapshot.commit) throw new EnvironmentError("DIGEST_MISMATCH", "The restored commit is not the snapshot's commit.", { expected: snapshot.commit, actual: head });
      const tree = await treeDigest(target, snapshot.commit);
      if (tree.digest !== snapshot.treeDigest) {
        throw new EnvironmentError("DIGEST_MISMATCH", "The restored files do not match the snapshot's digest; refusing to restore.", { snapshot: snapshot.id, expected: snapshot.treeDigest, actual: tree.digest });
      }
      return {
        environment: restored,
        receipt: { snapshot: snapshot.id, seq: snapshot.seq, commit: snapshot.commit, treeDigest: tree.digest, manifestDigest: snapshot.manifestDigest, files: tree.files, folder: target, verified: true },
      };
    } catch (error) {
      rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      if (error instanceof EnvironmentError) throw error;
      throw new EnvironmentError("RESTORE_FAILED", `The snapshot could not be restored: ${error instanceof Error ? error.message : error}`, { snapshot: snapshot.id });
    }
  }

  /** Removes the working copy. Snapshots stay in the snapshot repository. */
  async destroy() {
    if (!inside(this.root, this.folder) || this.folder === this.root) throw new EnvironmentError("UNSAFE_PATH", "Refusing to remove a folder outside the environment root.");
    rmSync(this.folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    return { destroyed: true, folder: this.folder, snapshotsKept: this.store };
  }
}
