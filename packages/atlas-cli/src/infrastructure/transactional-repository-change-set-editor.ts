import { createHash } from "node:crypto";
import { lstat, readFile, realpath, rm, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

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

export interface TransactionalRepositoryChangeSetEditorOptions {
  readonly maxPendingChangeSets?: number;
}

/**
 * Coordinates already-safe single-file edits into an ordered, compensating transaction.
 * This is intentionally not a general filesystem transaction: only create/update plans are
 * accepted, and a failed application is compensated from pre-edit checkpoints.
 */
export class TransactionalRepositoryChangeSetEditor implements RepositoryChangeSetEditor {
  private readonly maxPendingChangeSets: number;
  private readonly pending = new Map<string, readonly RepositoryFileEditPlan[]>();
  private readonly checkpoints = new Map<string, ReadonlyMap<string, string>>();

  public constructor(
    private readonly fileEditor: RepositoryFileEditor,
    options: TransactionalRepositoryChangeSetEditorOptions = {},
  ) {
    this.maxPendingChangeSets = positiveLimit(options.maxPendingChangeSets ?? 20);
  }

  public async preview(repositoryPath: string, requests: readonly RepositoryFileEditRequest[]): Promise<RepositoryChangeSetPlan> {
    if (requests.length === 0) throw changeSetError("EMPTY_CHANGE_SET", "A change set must include at least one edit.");
    const paths = new Set<string>();
    for (const request of requests) {
      const key = request.path.replaceAll("\\", "/").toLocaleLowerCase();
      if (paths.has(key)) throw changeSetError("DUPLICATE_PATH", "A change set cannot edit the same path twice.");
      paths.add(key);
    }

    const edits: RepositoryFileEditPlan[] = [];
    const captured = new Map<string, string>();
    try {
      for (const request of requests) {
        const plan = await this.fileEditor.preview(repositoryPath, request);
        edits.push(plan);
        if (plan.operation === "update") captured.set(plan.planDigest, await readCheckpoint(plan.root, plan.path, plan.beforeSha256));
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
    const checkpoints = this.checkpoints.get(plan.changeSetDigest) ?? new Map<string, string>();
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

  private async rollback(root: string, edits: readonly RepositoryFileEditPlan[], checkpoints: ReadonlyMap<string, string>): Promise<{ succeeded: string[]; failed: string[] }> {
    const succeeded: string[] = [];
    const failed: string[] = [];
    for (const edit of edits) {
      try {
        if (edit.operation === "update") {
          // Re-previewing forces the same containment, symlink, text, and current-hash checks as a forward edit.
          const content = checkpointFor(edit, checkpoints);
          const checkpoint = await this.fileEditor.preview(root, {
            operation: "update", path: edit.path, content, expectedSha256: edit.afterSha256,
          });
          await this.fileEditor.apply(checkpoint, { approved: true, planDigest: checkpoint.planDigest });
        } else {
          await removeCreatedFile(root, edit);
        }
        succeeded.push(edit.path);
      } catch {
        failed.push(edit.path);
      }
    }
    return { succeeded, failed };
  }
}

function checkpointFor(edit: RepositoryFileEditPlan, checkpoints: ReadonlyMap<string, string>): string {
  const expectedHash = edit.beforeSha256;
  if (expectedHash === null) throw changeSetError("ROLLBACK_FAILED", "An update checkpoint is unavailable.");
  const content = checkpoints.get(edit.planDigest);
  if (content === undefined || hash(content) !== expectedHash) throw changeSetError("ROLLBACK_FAILED", "An update checkpoint is unavailable.");
  return content;
}

async function readCheckpoint(root: string, path: string, expectedHash: string | null): Promise<string> {
  if (expectedHash === null) throw changeSetError("ROLLBACK_FAILED", "An update checkpoint is unavailable.");
  const target = await containedRegularFile(root, path);
  const bytes = await readFile(target);
  if (bytes.includes(0)) throw changeSetError("ROLLBACK_FAILED", "Update checkpoint is not text.");
  let content: string;
  try { content = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch (error) { throw changeSetError("ROLLBACK_FAILED", "Update checkpoint is not valid UTF-8.", error); }
  if (hash(content) !== expectedHash) throw changeSetError("ROLLBACK_FAILED", "Update checkpoint changed during preview.");
  return content;
}

async function removeCreatedFile(root: string, edit: RepositoryFileEditPlan): Promise<void> {
  const canonicalRoot = await realpath(root);
  if (canonicalRoot !== root || !(await stat(root)).isDirectory()) throw changeSetError("ROLLBACK_FAILED", "Repository root changed before rollback.");
  if (isAbsolute(edit.path)) throw changeSetError("ROLLBACK_FAILED", "Rollback path is invalid.");
  const target = await containedRegularFile(root, edit.path);
  const rel = relative(root, target);
  if (rel === "") throw changeSetError("ROLLBACK_FAILED", "Rollback path is invalid.");
  const info = await lstat(target);
  if (info.isSymbolicLink() || !info.isFile()) throw changeSetError("ROLLBACK_FAILED", "Rollback target is unsafe.");
  const bytes = await readFile(target);
  if (hash(bytes) !== edit.afterSha256) throw changeSetError("ROLLBACK_FAILED", "Created file changed before rollback.");
  await rm(target, { force: false });
}

async function containedRegularFile(root: string, path: string): Promise<string> {
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
