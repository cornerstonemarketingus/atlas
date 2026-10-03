import { createHash, randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/**
 * Undo for a coder session without touching Git history. Before a session's
 * first edit to a path, the path's bytes and mode (or its absence) are
 * recorded; when the session ends, what it left there is hashed and the
 * checkpoint is saved. `atlas undo` puts every recorded path back, but only
 * while each still holds exactly what the session left: a file someone edited
 * afterwards is a conflict, and then nothing is restored.
 *
 * Checkpoints live under the repository's Git directory (`.git/atlas/
 * checkpoints`), so they can never be committed or land in a pull request.
 * A directory that is not a Git checkout uses the system temp directory.
 */

export interface SessionCheckpointFile {
  readonly path: string;
  /** Base64 of the bytes before the session, or null when the path did not exist. */
  readonly before: string | null;
  readonly beforeMode: number | null;
  /** SHA-256 of the bytes the session left, or null when it left no file. */
  readonly afterSha256: string | null;
}

export interface SessionCheckpoint {
  readonly schemaVersion: 1;
  readonly sessionId: string;
  readonly createdAt: string;
  readonly root: string;
  readonly files: readonly SessionCheckpointFile[];
}

export interface UndoResult {
  readonly sessionId: string;
  readonly restored: readonly string[];
  /** Paths already back to their pre-session state. */
  readonly unchanged: readonly string[];
  /** Paths changed since the session; when any exist, nothing was restored. */
  readonly conflicts: readonly string[];
  readonly dryRun: boolean;
}

export class SessionCheckpointError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "SessionCheckpointError";
  }
}

interface Before {
  readonly bytes: Buffer | null;
  readonly mode: number | null;
}

/** Records what each path held before the session first touched it. */
export class SessionCheckpointRecorder {
  private readonly before = new Map<string, Before>();

  public constructor(private readonly root: string) {}

  /**
   * Call before a tool edits `paths`. Paths already recorded keep their
   * first state; paths the editor would refuse (outside the repository,
   * through a symlink, not a regular file) are skipped, since nothing will
   * be written there.
   */
  public async recordBefore(paths: readonly string[]): Promise<void> {
    for (const raw of paths) {
      const path = normalizedPath(raw);
      if (path === null || this.before.has(path)) continue;
      const target = await containedTarget(this.root, path);
      if (target === null) continue;
      let info;
      try { info = await lstat(target); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") this.before.set(path, { bytes: null, mode: null });
        continue;
      }
      if (!info.isFile()) continue;
      this.before.set(path, { bytes: await readFile(target), mode: info.mode & 0o7777 });
    }
  }

  /** Saves the checkpoint when the session changed anything; returns its session id or null. */
  public async save(sessionId: string, now: Date = new Date()): Promise<string | null> {
    const files: SessionCheckpointFile[] = [];
    for (const [path, before] of [...this.before].sort(([left], [right]) => left.localeCompare(right))) {
      const after = await currentSha256(this.root, path);
      const beforeSha = before.bytes === null ? null : sha256(before.bytes);
      if (after === beforeSha) continue;
      files.push({ path, before: before.bytes?.toString("base64") ?? null, beforeMode: before.mode, afterSha256: after });
    }
    if (files.length === 0) return null;
    const checkpoint: SessionCheckpoint = { schemaVersion: 1, sessionId: validSessionId(sessionId), createdAt: now.toISOString(), root: this.root, files };
    const directory = await checkpointDirectory(this.root);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeAtomic(join(directory, `${checkpoint.sessionId}.json`), `${JSON.stringify(checkpoint)}\n`, 0o600);
    return checkpoint.sessionId;
  }
}

/** Restores a session's checkpoint (the latest when no id is given). */
export async function undoSession(root: string, options: { readonly sessionId?: string; readonly dryRun?: boolean } = {}): Promise<UndoResult> {
  const directory = await checkpointDirectory(root);
  const sessionId = options.sessionId === undefined ? await latestSession(directory) : validSessionId(options.sessionId);
  let checkpoint: SessionCheckpoint;
  try {
    checkpoint = JSON.parse(await readFile(join(directory, `${sessionId}.json`), "utf8")) as SessionCheckpoint;
  } catch {
    throw new SessionCheckpointError(`No undo checkpoint for session ${sessionId}.`);
  }
  if (checkpoint.schemaVersion !== 1 || !Array.isArray(checkpoint.files)) throw new SessionCheckpointError("Unsupported checkpoint format.");

  const restore: SessionCheckpointFile[] = [];
  const unchanged: string[] = [];
  const conflicts: string[] = [];
  for (const file of checkpoint.files) {
    const path = normalizedPath(file.path);
    if (path === null || (await containedTarget(root, path)) === null) { conflicts.push(file.path); continue; }
    const current = await currentSha256(root, path);
    const before = file.before === null ? null : sha256(Buffer.from(file.before, "base64"));
    if (current === before) unchanged.push(path);
    else if (current === file.afterSha256) restore.push(file);
    else conflicts.push(path);
  }
  const dryRun = options.dryRun === true;
  if (conflicts.length > 0 || dryRun) {
    return { sessionId, restored: dryRun && conflicts.length === 0 ? restore.map((file) => file.path) : [], unchanged, conflicts, dryRun };
  }
  for (const file of restore) {
    const target = (await containedTarget(root, file.path))!;
    if (file.before === null) {
      await rm(target, { force: true });
    } else {
      await mkdir(dirname(target), { recursive: true });
      await writeAtomic(target, Buffer.from(file.before, "base64"), file.beforeMode ?? 0o644);
    }
  }
  // Kept, renamed: the record of what was undone, and never offered again.
  await rename(join(directory, `${sessionId}.json`), join(directory, `${sessionId}.undone.json`));
  return { sessionId, restored: restore.map((file) => file.path), unchanged, conflicts, dryRun };
}

async function latestSession(directory: string): Promise<string> {
  let names: string[];
  try { names = await readdir(directory); } catch { names = []; }
  let latest: { id: string; time: number } | null = null;
  for (const name of names) {
    if (!name.endsWith(".json") || name.endsWith(".undone.json")) continue;
    const time = (await stat(join(directory, name))).mtimeMs;
    if (latest === null || time > latest.time) latest = { id: name.slice(0, -".json".length), time };
  }
  if (latest === null) throw new SessionCheckpointError("No coder session to undo in this repository.");
  return latest.id;
}

/** `.git/atlas/checkpoints` (following a worktree's `.git` file), else the temp directory. */
export async function checkpointDirectory(root: string): Promise<string> {
  const dotGit = join(root, ".git");
  try {
    const info = await lstat(dotGit);
    if (info.isDirectory()) return join(dotGit, "atlas", "checkpoints");
    if (info.isFile()) {
      const pointer = /^gitdir:\s*(.+)$/mu.exec(await readFile(dotGit, "utf8"))?.[1]?.trim();
      if (pointer) return join(resolve(root, pointer), "atlas", "checkpoints");
    }
  } catch { /* not a Git checkout */ }
  return join(tmpdir(), "atlas-checkpoints", sha256(Buffer.from(root)).slice(0, 16));
}

function normalizedPath(value: unknown): string | null {
  if (typeof value !== "string" || value.trim() === "" || isAbsolute(value)) return null;
  return value.replaceAll("\\", "/");
}

/** The absolute path, or null when it would leave the repository or pass through a symlink. */
async function containedTarget(root: string, path: string): Promise<string | null> {
  const target = resolve(root, path);
  const fromRoot = relative(root, target);
  if (fromRoot === "" || fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) return null;
  const parts = fromRoot.split(sep);
  let cursor = root;
  for (const part of parts) {
    cursor = join(cursor, part);
    try { if ((await lstat(cursor)).isSymbolicLink()) return null; } catch { break; }
  }
  return target;
}

async function currentSha256(root: string, path: string): Promise<string | null> {
  const target = await containedTarget(root, path);
  if (target === null) return null;
  try {
    const info = await lstat(target);
    return info.isFile() ? sha256(await readFile(target)) : null;
  } catch {
    return null;
  }
}

async function writeAtomic(target: string, content: string | Buffer, mode: number): Promise<void> {
  const temporary = join(dirname(target), `.atlas-${randomBytes(8).toString("hex")}.tmp`);
  try {
    await writeFile(temporary, content, { flag: "wx", mode: 0o600 });
    await chmod(temporary, mode);
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

function validSessionId(value: string): string {
  if (!/^[A-Za-z0-9-]{1,100}$/u.test(value)) throw new SessionCheckpointError("Invalid session id.");
  return value;
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
