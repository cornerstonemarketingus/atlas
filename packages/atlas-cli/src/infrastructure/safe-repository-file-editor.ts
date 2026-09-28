import { createHash, randomBytes } from "node:crypto";
import { chmod, link, lstat, open, readFile, realpath, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import {
  RepositoryFileEditError,
  type RepositoryFileEditApproval,
  type RepositoryFileEditor,
  type RepositoryFileEditPlan,
  type RepositoryFileEditRequest,
  type RepositoryFileEditResult,
} from "../domain/repository-file-edit.js";
import { unifiedLineDiff } from "./line-diff.js";

const DEFAULT_MAX_FILE_BYTES = 1024 * 1024;
const DEFAULT_MAX_DIFF_BYTES = 128 * 1024;

export interface SafeRepositoryFileEditorOptions {
  readonly maxFileBytes?: number;
  readonly maxDiffBytes?: number;
  readonly maxPendingPlans?: number;
}

/** Digest input; also the plan's own shape, so preview and apply cannot drift apart. */
interface PlanIdentity {
  readonly root: string;
  readonly operation: RepositoryFileEditPlan["operation"];
  readonly path: string;
  readonly toPath: string | null;
  readonly expectedSha256: string | null;
  readonly beforeSha256: string | null;
  readonly afterSha256: string | null;
  readonly contentBytes: number;
}

export class SafeRepositoryFileEditor implements RepositoryFileEditor {
  private readonly maxFileBytes: number;
  private readonly maxDiffBytes: number;
  private readonly maxPendingPlans: number;
  /** null marks a pending plan that carries no new bytes (delete, rename). */
  private readonly contents = new Map<string, string | null>();

  public constructor(options: SafeRepositoryFileEditorOptions = {}) {
    this.maxFileBytes = positiveLimit(options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES);
    this.maxDiffBytes = positiveLimit(options.maxDiffBytes ?? DEFAULT_MAX_DIFF_BYTES);
    this.maxPendingPlans = positiveLimit(options.maxPendingPlans ?? 100);
  }

  public async preview(repositoryPath: string, request: RepositoryFileEditRequest): Promise<RepositoryFileEditPlan> {
    validateRequest(request);
    const root = await canonicalRoot(repositoryPath);
    const target = await validatePath(root, request.path);
    const before = await readCurrent(target, this.maxFileBytes);
    const path = relative(root, target).replaceAll("\\", "/");

    if (request.operation === "delete") {
      const current = requireExisting(before, "The delete target does not exist.", request.expectedSha256);
      const identity: PlanIdentity = { root, operation: "delete", path, toPath: null,
        expectedSha256: request.expectedSha256, beforeSha256: sha(current), afterSha256: null, contentBytes: 0 };
      return this.register(identity, null, deleteDiff(path, current, this.maxDiffBytes));
    }

    if (request.operation === "rename") {
      const current = requireExisting(before, "The rename source does not exist.", request.expectedSha256);
      const destination = await validatePath(root, request.toPath);
      const toPath = relative(root, destination).replaceAll("\\", "/");
      if (toPath === path) throw editError("INVALID_PLAN", "A rename destination must differ from its source.");
      await assertAbsent(destination, "The rename destination already exists.");
      const identity: PlanIdentity = { root, operation: "rename", path, toPath,
        expectedSha256: request.expectedSha256, beforeSha256: sha(current), afterSha256: sha(current),
        contentBytes: Buffer.byteLength(current) };
      return this.register(identity, null, renameDiff(path, toPath, this.maxDiffBytes));
    }

    const after = normalizeNewlines(request.content, await existingNewline(target));
    validateText(after, this.maxFileBytes);
    if (request.operation === "create") {
      if (request.mustNotExist !== true) throw editError("INVALID_PLAN", "Creates require mustNotExist: true.");
      if (before !== null) throw editError("FILE_ALREADY_EXISTS", "The create target already exists.");
    } else {
      if (!request.expectedSha256) throw editError("EXPECTED_HASH_REQUIRED", "Updates require expectedSha256.");
      if (before === null) throw editError("FILE_NOT_FOUND", "The update target does not exist.");
      if (sha(before) !== request.expectedSha256) throw editError("STALE_FILE", "The file hash does not match expectedSha256.");
    }
    const identity: PlanIdentity = { root, operation: request.operation, path, toPath: null,
      expectedSha256: request.operation === "update" ? request.expectedSha256 : null,
      beforeSha256: before === null ? null : sha(before), afterSha256: sha(after), contentBytes: Buffer.byteLength(after) };
    return this.register(identity, after, unifiedDiff(path, before ?? "", after, this.maxDiffBytes, before === null));
  }

  public async apply(plan: RepositoryFileEditPlan, approval: RepositoryFileEditApproval): Promise<RepositoryFileEditResult> {
    const digest = planDigest(plan);
    if (approval.approved !== true || approval.planDigest !== plan.planDigest || digest !== plan.planDigest) {
      throw editError("APPROVAL_MISMATCH", "Approval is not bound to this exact edit plan.");
    }
    const content = this.pendingContent(plan);
    const root = await canonicalRoot(plan.root);
    if (root !== plan.root) throw editError("INVALID_PLAN", "Repository root changed after preview.");
    const target = await validatePath(root, plan.path);
    const before = await readCurrent(target, this.maxFileBytes);
    const currentHash = before === null ? null : sha(before);
    if (currentHash !== plan.beforeSha256) throw editError("STALE_FILE", "The target changed after preview.");
    if (plan.operation === "create" && before !== null) throw editError("FILE_ALREADY_EXISTS", "The create target now exists.");
    if (plan.operation !== "create" && before === null) throw editError("FILE_NOT_FOUND", "The edit target no longer exists.");

    if (plan.operation === "delete") {
      try { await rm(target, { force: false }); }
      catch (error) { throw editError("IO_ERROR", "Could not remove the repository file.", error); }
    } else if (plan.operation === "rename") {
      await this.applyRename(root, plan, target);
    } else {
      if (content === null) throw editError("INVALID_PLAN", "Edit plan content is unavailable or invalid.");
      await writeAtomically(target, content);
    }
    this.contents.delete(plan.planDigest);
    return { schemaVersion: 1, root, operation: plan.operation, path: plan.path, toPath: plan.toPath,
      beforeSha256: plan.beforeSha256, afterSha256: plan.afterSha256, planDigest: plan.planDigest };
  }

  public discard(planDigest: string): boolean {
    return this.contents.delete(planDigest);
  }

  private register(identity: PlanIdentity, content: string | null, rendered: { text: string; truncated: boolean }): RepositoryFileEditPlan {
    const digest = sha(JSON.stringify(identity));
    if (!this.contents.has(digest) && this.contents.size >= this.maxPendingPlans) {
      throw editError("PLAN_CAPACITY_REACHED", "Pending edit plan capacity has been reached.");
    }
    this.contents.set(digest, content);
    return { schemaVersion: 1, ...identity, diff: rendered.text, diffTruncated: rendered.truncated, planDigest: digest };
  }

  private pendingContent(plan: RepositoryFileEditPlan): string | null {
    if (!this.contents.has(plan.planDigest)) throw editError("INVALID_PLAN", "Edit plan content is unavailable or invalid.");
    const content = this.contents.get(plan.planDigest) ?? null;
    const needsContent = plan.operation === "create" || plan.operation === "update";
    if (needsContent !== (content !== null)) throw editError("INVALID_PLAN", "Edit plan content does not match its operation.");
    if (content !== null && sha(content) !== plan.afterSha256) throw editError("INVALID_PLAN", "Edit plan content is unavailable or invalid.");
    return content;
  }

  /**
   * Moves with link+unlink rather than rename(2): rename silently clobbers an
   * existing destination, while link fails with EEXIST, so a file that appears
   * between preview and apply costs a loud error instead of someone's data.
   */
  private async applyRename(root: string, plan: RepositoryFileEditPlan, source: string): Promise<void> {
    if (plan.toPath === null) throw editError("INVALID_PLAN", "A rename plan requires a destination.");
    const destination = await validatePath(root, plan.toPath);
    await assertAbsent(destination, "The rename destination now exists.");
    try {
      await link(source, destination);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw editError("FILE_ALREADY_EXISTS", "The rename destination now exists.");
      throw editError("IO_ERROR", "Could not link the rename destination.", error);
    }
    try {
      await unlink(source);
    } catch (error) {
      // Leaving both paths linked would duplicate the file, so undo the half-done move.
      await rm(destination, { force: true }).catch(() => undefined);
      throw editError("IO_ERROR", "Could not remove the rename source.", error);
    }
  }
}

function validateRequest(request: RepositoryFileEditRequest): void {
  const operation: string = request.operation;
  if (operation !== "create" && operation !== "update" && operation !== "delete" && operation !== "rename") {
    throw editError("INVALID_PLAN", "Unsupported edit operation.");
  }
  if (!request.path || isAbsolute(request.path)) throw editError("ABSOLUTE_PATH_NOT_ALLOWED", "Edit paths must be non-empty and repository-relative.");
  if (request.operation === "rename" && (!request.toPath || isAbsolute(request.toPath))) {
    throw editError("ABSOLUTE_PATH_NOT_ALLOWED", "Rename destinations must be non-empty and repository-relative.");
  }
  if ((request.operation === "delete" || request.operation === "rename") && !request.expectedSha256) {
    throw editError("EXPECTED_HASH_REQUIRED", "Deletes and renames require expectedSha256.");
  }
}

function requireExisting(before: string | null, missingMessage: string, expectedSha256: string): string {
  if (before === null) throw editError("FILE_NOT_FOUND", missingMessage);
  if (sha(before) !== expectedSha256) throw editError("STALE_FILE", "The file hash does not match expectedSha256.");
  return before;
}

function planDigest(plan: RepositoryFileEditPlan): string {
  const identity: PlanIdentity = { root: plan.root, operation: plan.operation, path: plan.path, toPath: plan.toPath,
    expectedSha256: plan.expectedSha256, beforeSha256: plan.beforeSha256, afterSha256: plan.afterSha256,
    contentBytes: plan.contentBytes };
  return sha(JSON.stringify(identity));
}

async function canonicalRoot(repositoryPath: string): Promise<string> {
  try { const root = await realpath(repositoryPath); if (!(await stat(root)).isDirectory()) throw new Error("not directory"); return root; }
  catch (error) { throw editError("IO_ERROR", "Repository root is unavailable.", error); }
}

async function validatePath(root: string, path: string): Promise<string> {
  const target = resolve(root, path);
  const rel = relative(root, target);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw editError("PATH_OUTSIDE_REPOSITORY", "Edit path resolves outside the repository.");
  const parts = rel.split(sep);
  let cursor = root;
  for (let index = 0; index < parts.length - 1; index += 1) {
    cursor = resolve(cursor, parts[index]!);
    let info;
    try { info = await lstat(cursor); } catch (error) { throw editError("PARENT_NOT_DIRECTORY", "Every parent directory must already exist.", error); }
    if (info.isSymbolicLink()) throw editError("SYMLINK_NOT_ALLOWED", "Edit paths cannot traverse symbolic links.");
    if (!info.isDirectory()) throw editError("PARENT_NOT_DIRECTORY", "An edit parent is not a directory.");
  }
  try { if ((await lstat(target)).isSymbolicLink()) throw editError("SYMLINK_NOT_ALLOWED", "Symbolic-link targets cannot be edited."); }
  catch (error) { if (error instanceof RepositoryFileEditError) throw error; if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw editError("IO_ERROR", "Could not inspect edit target.", error); }
  return target;
}

async function assertAbsent(path: string, message: string): Promise<void> {
  try { await lstat(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw editError("IO_ERROR", "Could not inspect the rename destination.", error);
  }
  throw editError("FILE_ALREADY_EXISTS", message);
}

/**
 * Writes through a temporary file and rename, keeping what the edit did not
 * mean to change: an existing file's permission bits (an executable script
 * stays executable) and its UTF-8 byte-order mark. Hashes and diffs are over
 * the text without the mark, as the read tools report it. A new file gets
 * the process default mode (umask applies), like any file the user creates.
 */
export async function writeAtomically(target: string, content: string): Promise<void> {
  const temporary = resolve(dirname(target), `.atlas-${randomBytes(12).toString("hex")}.tmp`);
  let existing: { mode: number; bom: boolean } | null = null;
  try {
    const info = await stat(target);
    const head = Buffer.alloc(3);
    const handle = await open(target, "r");
    try { await handle.read(head, 0, 3, 0); } finally { await handle.close(); }
    existing = { mode: info.mode & 0o7777, bom: head.equals(UTF8_BOM) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw editError("IO_ERROR", "Could not inspect edit target.", error);
  }
  try {
    const text = existing?.bom && !content.startsWith("\uFEFF") ? `\uFEFF${content}` : content;
    await writeFile(temporary, text, { encoding: "utf8", flag: "wx" });
    if (existing) await chmod(temporary, existing.mode);
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw editError("IO_ERROR", "Could not atomically apply the repository edit.", error);
  }
}

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);

async function readCurrent(path: string, maxBytes: number): Promise<string | null> {
  let info; try { info = await lstat(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw editError("IO_ERROR", "Could not inspect edit target.", error); }
  if (!info.isFile()) throw editError("NOT_A_FILE", "Edit target is not a regular file.");
  if (info.size > maxBytes) throw editError("CHANGE_TOO_LARGE", "Existing file exceeds the configured size limit.");
  const bytes = await readFile(path);
  if (bytes.includes(0)) throw editError("INVALID_TEXT", "Binary files cannot be edited.");
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch (error) { throw editError("INVALID_TEXT", "Existing file is not valid UTF-8.", error); }
}

async function existingNewline(path: string): Promise<"\r\n" | "\n"> {
  try { const value = await readFile(path, "utf8"); return value.includes("\r\n") ? "\r\n" : "\n"; } catch { return "\n"; }
}
function normalizeNewlines(value: string, newline: "\r\n" | "\n"): string { return value.replace(/\r\n|\r|\n/g, newline); }
function validateText(value: string, maxBytes: number): void {
  if (value.includes("\0") || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value)) throw editError("INVALID_TEXT", "New content must be valid UTF-8 text.");
  if (Buffer.byteLength(value) > maxBytes) throw editError("CHANGE_TOO_LARGE", "New content exceeds the configured size limit.");
}
function sha(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }
function positiveLimit(value: number): number { if (!Number.isSafeInteger(value) || value < 1) throw new TypeError("Limits must be positive integers."); return value; }
function unifiedDiff(path: string, before: string, after: string, maxBytes: number, created: boolean): { text: string; truncated: boolean } {
  return boundedDiff(unifiedLineDiff(before, after, created ? null : `a/${path}`, `b/${path}`), maxBytes);
}
function deleteDiff(path: string, before: string, maxBytes: number): { text: string; truncated: boolean } {
  return boundedDiff(unifiedLineDiff(before, "", `a/${path}`, null), maxBytes);
}
function renameDiff(path: string, toPath: string, maxBytes: number): { text: string; truncated: boolean } {
  return boundedDiff([`--- a/${path}`, `+++ b/${toPath}`, "@@ rename with unchanged contents @@"], maxBytes);
}
function boundedDiff(lines: readonly string[], maxBytes: number): { text: string; truncated: boolean } {
  const full = lines.join("\n"); if (Buffer.byteLength(full) <= maxBytes) return { text: full, truncated: false };
  const marker = "... diff truncated ...";
  if (Buffer.byteLength(marker) > maxBytes) return { text: truncateUtf8(marker, maxBytes), truncated: true };
  let text = ""; for (const line of lines) { const next = `${text}${text ? "\n" : ""}${line}`; if (Buffer.byteLength(`${next}\n${marker}`) > maxBytes) break; text = next; }
  return { text: text ? `${text}\n${marker}` : marker, truncated: true };
}
function truncateUtf8(value: string, maxBytes: number): string {
  let result = "";
  for (const character of value) {
    if (Buffer.byteLength(result + character) > maxBytes) break;
    result += character;
  }
  return result;
}
function editError(code: ConstructorParameters<typeof RepositoryFileEditError>[0], message: string, cause?: unknown): RepositoryFileEditError {
  return new RepositoryFileEditError(code, message, cause === undefined ? undefined : { cause });
}
