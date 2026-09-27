import { createHash, randomBytes } from "node:crypto";
import { chmod, lstat, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import {
  RepositoryChangeSetError,
  type RepositoryChangeSetApproval,
  type RepositoryChangeSetEditor,
  type RepositoryChangeSetPlan,
  type RepositoryChangeSetResult,
} from "../domain/repository-change-set.js";
import {
  RepositoryFileEditError,
  type RepositoryFileEditPlan,
  type RepositoryFileEditRequest,
  type RepositoryFileEditResult,
  type RepositoryFileEditor,
} from "../domain/repository-file-edit.js";

const DEFAULT_MAX_EDITS = 50;
const DEFAULT_MAX_CHANGE_SET_BYTES = 4 * 1024 * 1024;

export interface TransactionalRepositoryChangeSetEditorOptions {
  readonly maxPendingChangeSets?: number;
  readonly maxEdits?: number;
  readonly maxChangeSetBytes?: number;
}

/**
 * Coordinates already-safe single-file edits into an ordered, compensating transaction.
 * This is intentionally not a general filesystem transaction: create, update, delete, and
 * rename plans are accepted, and a failed application is compensated in reverse order from
 * pre-edit checkpoints. Directories are never created or removed.
 */
export class TransactionalRepositoryChangeSetEditor implements RepositoryChangeSetEditor {
  private readonly maxPendingChangeSets: number;
  private readonly maxEdits: number;
  private readonly maxChangeSetBytes: number;
  private readonly pending = new Map<string, readonly RepositoryFileEditPlan[]>();
  private readonly checkpoints = new Map<string, ReadonlyMap<string, Checkpoint>>();

  public constructor(
    private readonly fileEditor: RepositoryFileEditor,
    options: TransactionalRepositoryChangeSetEditorOptions = {},
  ) {
    this.maxPendingChangeSets = positiveLimit(options.maxPendingChangeSets ?? 20);
    this.maxEdits = positiveLimit(options.maxEdits ?? DEFAULT_MAX_EDITS);
    this.maxChangeSetBytes = positiveLimit(options.maxChangeSetBytes ?? DEFAULT_MAX_CHANGE_SET_BYTES);
  }

  public async preview(repositoryPath: string, requests: readonly RepositoryFileEditRequest[]): Promise<RepositoryChangeSetPlan> {
    if (requests.length === 0) throw changeSetError("EMPTY_CHANGE_SET", "A change set must include at least one edit.");
    if (requests.length > this.maxEdits) throw changeSetError("CHANGE_SET_TOO_LARGE", `A change set cannot exceed ${this.maxEdits} edits.`);
    let bytes = 0;
    for (const request of requests) {
      if (request.operation === "create" || request.operation === "update") bytes += Buffer.byteLength(request.content);
    }
    if (bytes > this.maxChangeSetBytes) throw changeSetError("CHANGE_SET_TOO_LARGE", `A change set cannot exceed ${this.maxChangeSetBytes} content bytes.`);

    // Every path a change set touches — a rename's destination included — must be claimed
    // once, so two edits can never race for the same file inside one transaction.
    const claimed = new Set<string>();
    for (const request of requests) {
      const paths = request.operation === "rename" ? [request.path, request.toPath] : [request.path];
      for (const path of paths) {
        const key = path.replaceAll("\\", "/").toLocaleLowerCase();
        if (claimed.has(key)) throw changeSetError("DUPLICATE_PATH", "A change set cannot touch the same path twice.");
        claimed.add(key);
      }
    }

    const edits: RepositoryFileEditPlan[] = [];
    const captured = new Map<string, Checkpoint>();
    try {
      for (const request of requests) {
        const plan = await this.fileEditor.preview(repositoryPath, request);
        edits.push(plan);
        // Updates and deletes destroy bytes, so rollback needs them captured up front.
        if (plan.operation === "update" || plan.operation === "delete") {
          captured.set(plan.planDigest, await readCheckpoint(plan.root, plan.path, plan.beforeSha256));
        }
      }
    } catch (error) {
      for (const plan of edits) this.fileEditor.discard(plan.planDigest);
      throw error;
    }
    const root = edits[0]!.root;
    if (edits.some((plan) => plan.root !== root)) {
      for (const plan of edits) this.fileEditor.discard(plan.planDigest);
      throw changeSetError("ROOT_MISMATCH", "All planned edits must resolve to one repository root.");
    }
    const changeSetDigest = digest(root, edits);
    if (!this.pending.has(changeSetDigest) && this.pending.size >= this.maxPendingChangeSets) {
      for (const plan of edits) this.fileEditor.discard(plan.planDigest);
      throw changeSetError("PLAN_CAPACITY_REACHED", "Pending change-set capacity has been reached.");
    }
    this.pending.set(changeSetDigest, edits);
    this.checkpoints.set(changeSetDigest, captured);
    return { schemaVersion: 1, root, edits, changeSetDigest };
  }

  public async apply(plan: RepositoryChangeSetPlan, approval: RepositoryChangeSetApproval): Promise<RepositoryChangeSetResult> {
    const expectedDigest = digest(plan.root, plan.edits);
    if (approval.approved !== true || approval.changeSetDigest !== plan.changeSetDigest || expectedDigest !== plan.changeSetDigest) {
      throw changeSetError("APPROVAL_MISMATCH", "Approval is not bound to this exact change set.");
    }
    const pendingEdits = this.pending.get(plan.changeSetDigest);
    if (pendingEdits === undefined || !samePlans(pendingEdits, plan.edits)) {
      throw changeSetError("INVALID_PLAN", "Change-set plans are unavailable or have been changed.");
    }
    this.pending.delete(plan.changeSetDigest);
    const checkpoints = this.checkpoints.get(plan.changeSetDigest) ?? new Map<string, Checkpoint>();
    this.checkpoints.delete(plan.changeSetDigest);

    const applied: RepositoryFileEditResult[] = [];
    try {
      for (const edit of plan.edits) {
        applied.push(await this.fileEditor.apply(edit, { approved: true, planDigest: edit.planDigest }));
      }
      return {
        schemaVersion: 1, root: plan.root, changeSetDigest: plan.changeSetDigest, applied,
        rollbackStatus: "not-needed", rolledBackPaths: [], rollbackFailedPaths: [], failure: null,
      };
    } catch (error) {
      const rollback = await this.rollback(plan.root, [...plan.edits].slice(0, applied.length).reverse(), checkpoints);
      for (const edit of plan.edits.slice(applied.length)) this.fileEditor.discard(edit.planDigest);
      return {
        schemaVersion: 1, root: plan.root, changeSetDigest: plan.changeSetDigest, applied,
        rollbackStatus: rollback.failed.length === 0 ? "rolled-back" : "rollback-failed",
        rolledBackPaths: rollback.succeeded, rollbackFailedPaths: rollback.failed,
        failure: failureDetails(error),
      };
    }
  }

  public discard(changeSetDigest: string): boolean {
    const edits = this.pending.get(changeSetDigest);
    if (edits === undefined) return false;
    this.pending.delete(changeSetDigest);
    this.checkpoints.delete(changeSetDigest);
    for (const edit of edits) this.fileEditor.discard(edit.planDigest);
    return true;
  }

  private async rollback(root: string, edits: readonly RepositoryFileEditPlan[], checkpoints: ReadonlyMap<string, Checkpoint>): Promise<{ succeeded: string[]; failed: string[] }> {
    const succeeded: string[] = [];
    const failed: string[] = [];
    for (const edit of edits) {
      try {
        await this.compensate(root, edit, checkpoints);
        succeeded.push(edit.path);
      } catch {
        failed.push(edit.path);
      }
    }
    return { succeeded, failed };
  }

  private async compensate(root: string, edit: RepositoryFileEditPlan, checkpoints: ReadonlyMap<string, Checkpoint>): Promise<void> {
    if (edit.operation === "update") {
      // Re-previewing forces the same containment, symlink, text, and current-hash checks as a forward edit.
      const { content } = checkpointFor(edit, checkpoints);
      const checkpoint = await this.fileEditor.preview(root, {
        operation: "update", path: edit.path, content, expectedSha256: nonNull(edit.afterSha256),
      });
      await this.fileEditor.apply(checkpoint, { approved: true, planDigest: checkpoint.planDigest });
      return;
    }
    if (edit.operation === "create") {
      await removeCreatedFile(root, edit);
      return;
    }
    if (edit.operation === "rename") {
      // The inverse move runs through the editor, so the original path is re-validated
      // and a file that reappeared there blocks the restore instead of being clobbered.
      const back = await this.fileEditor.preview(root, {
        operation: "rename", path: nonNull(edit.toPath), toPath: edit.path, expectedSha256: nonNull(edit.afterSha256),
      });
      await this.fileEditor.apply(back, { approved: true, planDigest: back.planDigest });
      return;
    }
    // A delete is restored byte-for-byte rather than replayed as a create: a create
    // normalizes newlines to the repository default, which would corrupt a CRLF file.
    await restoreDeletedFile(root, edit, checkpointFor(edit, checkpoints));
  }
}

/** The bytes an edit destroys, plus what a restore must put back around them. */
interface Checkpoint {
  readonly content: string;
  readonly mode: number;
  readonly bom: boolean;
}

function checkpointFor(edit: RepositoryFileEditPlan, checkpoints: ReadonlyMap<string, Checkpoint>): Checkpoint {
  const expectedHash = edit.beforeSha256;
  if (expectedHash === null) throw changeSetError("ROLLBACK_FAILED", "An edit checkpoint is unavailable.");
  const checkpoint = checkpoints.get(edit.planDigest);
  if (checkpoint === undefined || hash(checkpoint.content) !== expectedHash) throw changeSetError("ROLLBACK_FAILED", "An edit checkpoint is unavailable.");
  return checkpoint;
}

function nonNull(value: string | null): string {
  if (value === null) throw changeSetError("ROLLBACK_FAILED", "A rollback hash or path is missing from the plan.");
  return value;
}

async function readCheckpoint(root: string, path: string, expectedHash: string | null): Promise<Checkpoint> {
  if (expectedHash === null) throw changeSetError("ROLLBACK_FAILED", "An edit checkpoint is unavailable.");
  const target = await containedPath(root, path, "file");
  const mode = (await stat(target)).mode & 0o7777;
  const bytes = await readFile(target);
  if (bytes.includes(0)) throw changeSetError("ROLLBACK_FAILED", "Edit checkpoint is not text.");
  let content: string;
  try { content = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch (error) { throw changeSetError("ROLLBACK_FAILED", "Edit checkpoint is not valid UTF-8.", error); }
  if (hash(content) !== expectedHash) throw changeSetError("ROLLBACK_FAILED", "Edit checkpoint changed during preview.");
  return { content, mode, bom: bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf };
}

async function removeCreatedFile(root: string, edit: RepositoryFileEditPlan): Promise<void> {
  await assertStableRoot(root);
  if (isAbsolute(edit.path)) throw changeSetError("ROLLBACK_FAILED", "Rollback path is invalid.");
  const target = await containedPath(root, edit.path, "file");
  const bytes = await readFile(target);
  if (hash(bytes) !== edit.afterSha256) throw changeSetError("ROLLBACK_FAILED", "Created file changed before rollback.");
  await rm(target, { force: false });
}

async function restoreDeletedFile(root: string, edit: RepositoryFileEditPlan, checkpoint: Checkpoint): Promise<void> {
  await assertStableRoot(root);
  const target = await containedPath(root, edit.path, "absent");
  const temporary = resolve(dirname(target), `.atlas-rollback-${randomBytes(12).toString("hex")}.tmp`);
  try {
    // Byte-for-byte as it was: the mark, the text, and the permission bits.
    await writeFile(temporary, checkpoint.bom ? `\uFEFF${checkpoint.content}` : checkpoint.content, { encoding: "utf8", flag: "wx" });
    await chmod(temporary, checkpoint.mode);
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw changeSetError("ROLLBACK_FAILED", "Could not restore a deleted file.", error);
  }
}

async function assertStableRoot(root: string): Promise<void> {
  const canonical = await realpath(root);
  if (canonical !== root || !(await stat(root)).isDirectory()) throw changeSetError("ROLLBACK_FAILED", "Repository root changed before rollback.");
}

async function containedPath(root: string, path: string, expect: "file" | "absent"): Promise<string> {
  if (isAbsolute(path)) throw changeSetError("ROLLBACK_FAILED", "Rollback path is invalid.");
  const target = resolve(root, path);
  const rel = relative(root, target);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw changeSetError("ROLLBACK_FAILED", "Rollback path escapes the repository.");
  let cursor = root;
  for (const segment of rel.split(sep).slice(0, -1)) {
    cursor = resolve(cursor, segment);
    const info = await lstat(cursor);
    if (info.isSymbolicLink() || !info.isDirectory()) throw changeSetError("ROLLBACK_FAILED", "Rollback path is unsafe.");
  }
  if (expect === "absent") {
    try { await lstat(target); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return target;
      throw changeSetError("ROLLBACK_FAILED", "Could not inspect the rollback target.", error);
    }
    throw changeSetError("ROLLBACK_FAILED", "The rollback target reappeared.");
  }
  const info = await lstat(target);
  if (info.isSymbolicLink() || !info.isFile()) throw changeSetError("ROLLBACK_FAILED", "Rollback target is unsafe.");
  return target;
}

function digest(root: string, edits: readonly RepositoryFileEditPlan[]): string {
  return hash(JSON.stringify({ root, plans: edits.map((edit) => edit.planDigest) }));
}
function samePlans(left: readonly RepositoryFileEditPlan[], right: readonly RepositoryFileEditPlan[]): boolean {
  return left.length === right.length && left.every((plan, index) => plan.planDigest === right[index]?.planDigest);
}
function hash(value: string | Uint8Array): string { return createHash("sha256").update(value).digest("hex"); }
function positiveLimit(value: number): number { if (!Number.isSafeInteger(value) || value < 1) throw new TypeError("Limits must be positive integers."); return value; }
function changeSetError(code: ConstructorParameters<typeof RepositoryChangeSetError>[0], message: string, cause?: unknown): RepositoryChangeSetError {
  return new RepositoryChangeSetError(code, message, cause === undefined ? undefined : { cause });
}
function failureDetails(error: unknown): { code: string; message: string } {
  if (error instanceof RepositoryFileEditError || error instanceof RepositoryChangeSetError) return { code: error.code, message: error.message };
  return { code: "IO_ERROR", message: error instanceof Error ? error.message : "An unknown edit failure occurred." };
}
