import { createHash, randomBytes } from "node:crypto";
import { lstat, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import {
  RepositoryFileEditError,
  type RepositoryFileEditApproval,
  type RepositoryFileEditor,
  type RepositoryFileEditPlan,
  type RepositoryFileEditRequest,
  type RepositoryFileEditResult,
} from "../domain/repository-file-edit.js";

const DEFAULT_MAX_FILE_BYTES = 1024 * 1024;
const DEFAULT_MAX_DIFF_BYTES = 128 * 1024;

export interface SafeRepositoryFileEditorOptions {
  readonly maxFileBytes?: number;
  readonly maxDiffBytes?: number;
  readonly maxPendingPlans?: number;
}

export class SafeRepositoryFileEditor implements RepositoryFileEditor {
  private readonly maxFileBytes: number;
  private readonly maxDiffBytes: number;
  private readonly maxPendingPlans: number;
  private readonly contents = new Map<string, string>();

  public constructor(options: SafeRepositoryFileEditorOptions = {}) {
    this.maxFileBytes = positiveLimit(options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES);
    this.maxDiffBytes = positiveLimit(options.maxDiffBytes ?? DEFAULT_MAX_DIFF_BYTES);
    this.maxPendingPlans = positiveLimit(options.maxPendingPlans ?? 100);
  }

  public async preview(repositoryPath: string, request: RepositoryFileEditRequest): Promise<RepositoryFileEditPlan> {
    validateRequest(request);
    const root = await canonicalRoot(repositoryPath);
    const target = await validatePath(root, request.path);
    const after = normalizeNewlines(request.content, await existingNewline(target));
    validateText(after, this.maxFileBytes);
    const before = await readCurrent(target, this.maxFileBytes);

    if (request.operation === "create") {
      if (request.mustNotExist !== true) throw editError("INVALID_PLAN", "Creates require mustNotExist: true.");
      if (before !== null) throw editError("FILE_ALREADY_EXISTS", "The create target already exists.");
    } else {
      if (!request.expectedSha256) throw editError("EXPECTED_HASH_REQUIRED", "Updates require expectedSha256.");
      if (before === null) throw editError("FILE_NOT_FOUND", "The update target does not exist.");
      if (sha(before) !== request.expectedSha256) throw editError("STALE_FILE", "The file hash does not match expectedSha256.");
    }

    const path = relative(root, target).replaceAll("\\", "/");
    const beforeSha256 = before === null ? null : sha(before);
    const afterSha256 = sha(after);
    const digestInput = { root, operation: request.operation, path, expectedSha256: request.expectedSha256 ?? null,
      beforeSha256, afterSha256, contentBytes: Buffer.byteLength(after) };
    const planDigest = sha(JSON.stringify(digestInput));
    const rendered = unifiedDiff(path, before ?? "", after, this.maxDiffBytes, before === null);
    if (!this.contents.has(planDigest) && this.contents.size >= this.maxPendingPlans) {
      throw editError("PLAN_CAPACITY_REACHED", "Pending edit plan capacity has been reached.");
    }
    this.contents.set(planDigest, after);
    return { schemaVersion: 1, ...digestInput, diff: rendered.text, diffTruncated: rendered.truncated, planDigest };
  }

  public async apply(plan: RepositoryFileEditPlan, approval: RepositoryFileEditApproval): Promise<RepositoryFileEditResult> {
    const digest = sha(JSON.stringify({ root: plan.root, operation: plan.operation, path: plan.path,
      expectedSha256: plan.expectedSha256, beforeSha256: plan.beforeSha256, afterSha256: plan.afterSha256,
      contentBytes: plan.contentBytes }));
    if (approval.approved !== true || approval.planDigest !== plan.planDigest || digest !== plan.planDigest) {
      throw editError("APPROVAL_MISMATCH", "Approval is not bound to this exact edit plan.");
    }
    const content = this.contents.get(plan.planDigest);
    if (content === undefined || sha(content) !== plan.afterSha256) throw editError("INVALID_PLAN", "Edit plan content is unavailable or invalid.");
    const root = await canonicalRoot(plan.root);
    if (root !== plan.root) throw editError("INVALID_PLAN", "Repository root changed after preview.");
    const target = await validatePath(root, plan.path);
    const before = await readCurrent(target, this.maxFileBytes);
    const currentHash = before === null ? null : sha(before);
    if (currentHash !== plan.beforeSha256) throw editError("STALE_FILE", "The target changed after preview.");
    if (plan.operation === "create" && before !== null) throw editError("FILE_ALREADY_EXISTS", "The create target now exists.");
    if (plan.operation === "update" && before === null) throw editError("FILE_NOT_FOUND", "The update target no longer exists.");

    const temporary = resolve(dirname(target), `.atlas-${randomBytes(12).toString("hex")}.tmp`);
    try {
      await writeFile(temporary, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
      await rename(temporary, target);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw editError("IO_ERROR", "Could not atomically apply the repository edit.", error);
    }
    this.contents.delete(plan.planDigest);
    return { schemaVersion: 1, root, operation: plan.operation, path: plan.path,
      beforeSha256: plan.beforeSha256, afterSha256: plan.afterSha256, planDigest: plan.planDigest };
  }

  public discard(planDigest: string): boolean {
    return this.contents.delete(planDigest);
  }
}

function validateRequest(request: RepositoryFileEditRequest): void {
  if (request.operation !== "create" && request.operation !== "update") throw editError("INVALID_PLAN", "Unsupported edit operation.");
  if (!request.path || isAbsolute(request.path)) throw editError("ABSOLUTE_PATH_NOT_ALLOWED", "Edit paths must be non-empty and repository-relative.");
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
  const oldLines = before.replace(/\r\n/g, "\n").split("\n"); const newLines = after.replace(/\r\n/g, "\n").split("\n");
  const lines = [`--- ${created ? "/dev/null" : `a/${path}`}`, `+++ b/${path}`, `@@ -1,${created ? 0 : oldLines.length} +1,${newLines.length} @@`,
    ...(!created ? oldLines.map((line) => `-${line}`) : []), ...newLines.map((line) => `+${line}`)];
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
