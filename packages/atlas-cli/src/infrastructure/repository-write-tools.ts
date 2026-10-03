import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import type { ReadOnlyToolContext, ReadOnlyToolDefinition, ReadOnlyToolRegistry } from "../domain/read-only-tool-registry.js";
import type {
  RepositoryChangeSetEditor,
  RepositoryChangeSetRollbackStatus,
} from "../domain/repository-change-set.js";
import type {
  RepositoryFileEditOperation,
  RepositoryFileEditRequest,
  RepositoryFileEditor,
} from "../domain/repository-file-edit.js";
import { loadGeneratedFilePolicy } from "./generated-file-policy.js";
import { RepositoryToolInputError, type RepositoryToolBinding } from "./repository-read-only-tools.js";
import { TransactionalRepositoryChangeSetEditor } from "./transactional-repository-change-set-editor.js";

const MAX_PATH_LENGTH = 4_096;
const MAX_CONTENT_BYTES = 1024 * 1024;
const MAX_CHANGE_SET_EDITS = 25;
const MAX_CHANGE_SET_BYTES = 2 * 1024 * 1024;
const CHANGE_SET_OPERATIONS = ["create", "update", "delete", "rename"] as const;

export interface ProposeFileEditInput {
  readonly path: string;
  readonly content: string;
  /** Confirms a hand edit of a lockfile, dependency, vendored or generated file. */
  readonly allowGenerated?: boolean;
}

export interface ProposeFileEditOutput {
  readonly path: string;
  readonly operation: "create" | "update";
  readonly diff: string;
  readonly diffTruncated: boolean;
}

export type ProposeChangeSetEditInput = (
  | { readonly operation: "create"; readonly path: string; readonly content: string }
  | { readonly operation: "update"; readonly path: string; readonly content: string }
  | { readonly operation: "delete"; readonly path: string }
  | { readonly operation: "rename"; readonly path: string; readonly toPath: string }
) & { readonly allowGenerated?: boolean };

export interface ProposeChangeSetInput {
  readonly edits: readonly ProposeChangeSetEditInput[];
}

export interface ProposeChangeSetEditOutput {
  readonly operation: RepositoryFileEditOperation;
  readonly path: string;
  readonly toPath: string | null;
  readonly diff: string;
  readonly diffTruncated: boolean;
}

export interface ProposeChangeSetOutput {
  readonly changeSetDigest: string;
  readonly applied: readonly ProposeChangeSetEditOutput[];
}

export type RepositoryChangeSetToolErrorCode = "CHANGE_SET_FAILED" | "CHANGE_SET_ROLLBACK_FAILED";

/** Carries whether the working tree was restored, because the agent's next move depends on it. */
export class RepositoryChangeSetToolError extends Error {
  public constructor(
    public readonly code: RepositoryChangeSetToolErrorCode,
    message: string,
    public readonly failureCode: string,
    public readonly rollbackStatus: RepositoryChangeSetRollbackStatus,
    public readonly rollbackFailedPaths: readonly string[],
  ) {
    super(message);
    this.name = "RepositoryChangeSetToolError";
  }
}

export interface RepositoryWriteToolServices {
  readonly editor: RepositoryFileEditor;
  /** Defaults to a transaction over `editor`; injected so tests can drive failures. */
  readonly changeSetEditor?: RepositoryChangeSetEditor;
}

export interface RepositoryWriteTools {
  readonly proposeFileEdit: ReadOnlyToolDefinition<ProposeFileEditInput, ProposeFileEditOutput>;
  readonly proposeChangeSet: ReadOnlyToolDefinition<ProposeChangeSetInput, ProposeChangeSetOutput>;
}

/**
 * Creates the write tools an agent may use, permanently bound to one repository
 * working tree. They preview and immediately apply edits through the
 * digest-bound editors rather than pausing for a per-edit approval: the real
 * safety boundary here is that this working tree is disposable (a fresh CI
 * checkout) and reaches anything shared only via a pull request a human or CI
 * gate reviews before merge.
 */
export function createRepositoryWriteTools(
  binding: RepositoryToolBinding,
  services: RepositoryWriteToolServices,
): RepositoryWriteTools {
  if (binding.repositoryId.trim().length === 0 || binding.repositoryRoot.trim().length === 0) {
    throw new Error("Repository tool bindings require a repository ID and root.");
  }
  const changeSetEditor = services.changeSetEditor ?? new TransactionalRepositoryChangeSetEditor(services.editor, {
    maxEdits: MAX_CHANGE_SET_EDITS,
    maxChangeSetBytes: MAX_CHANGE_SET_BYTES,
  });

  return {
    proposeFileEdit: {
      name: "repository.propose_file_edit",
      description: "Create a new file or overwrite an existing one with exact full file content. Applied immediately to the disposable working tree and diffed for review.",
      risk: "high",
      capability: "write",
      validateInput: validateProposeFileEditInput,
      execute: async (input, context) => {
        assertRepositoryBinding(binding, context);
        const expectedSha256 = await currentSha256(binding.repositoryRoot, input.path);
        const operation = expectedSha256 === null ? "create" : "update";
        const plan = await services.editor.preview(binding.repositoryRoot, expectedSha256 === null
          ? { operation: "create", path: input.path, content: input.content, mustNotExist: true }
          : { operation: "update", path: input.path, content: input.content, expectedSha256 });
        try {
          await assertNotProtected(binding.repositoryRoot, [{ paths: [plan.path], allowGenerated: input.allowGenerated === true }]);
        } catch (error) {
          services.editor.discard(plan.planDigest);
          throw error;
        }
        await services.editor.apply(plan, { approved: true, planDigest: plan.planDigest });
        return { path: plan.path, operation, diff: plan.diff, diffTruncated: plan.diffTruncated };
      },
    },
    proposeChangeSet: {
      name: "repository.propose_change_set",
      description: "Apply a batch of file creations, updates, deletions, and renames as one atomic change set. Every edit lands or none does: if any edit fails, the already-applied edits are rolled back. Use this for any change touching more than one file, and for every rename, move, or deletion.",
      risk: "high",
      capability: "write",
      validateInput: validateProposeChangeSetInput,
      execute: async (input, context) => {
        assertRepositoryBinding(binding, context);
        const requests: RepositoryFileEditRequest[] = [];
        for (const edit of input.edits) {
          requests.push(await toEditRequest(binding.repositoryRoot, edit));
        }
        const plan = await changeSetEditor.preview(binding.repositoryRoot, requests);
        try {
          await assertNotProtected(binding.repositoryRoot, input.edits.map((edit) => ({
            paths: edit.operation === "rename" ? [edit.path, edit.toPath] : [edit.path],
            allowGenerated: edit.allowGenerated === true,
          })));
        } catch (error) {
          changeSetEditor.discard(plan.changeSetDigest);
          throw error;
        }
        const result = await changeSetEditor.apply(plan, { approved: true, changeSetDigest: plan.changeSetDigest });
        if (result.failure !== null) throw changeSetToolError(result.failure, result.rollbackStatus, result.rollbackFailedPaths);
        return {
          changeSetDigest: result.changeSetDigest,
          applied: plan.edits.map((edit) => ({
            operation: edit.operation, path: edit.path, toPath: edit.toPath,
            diff: edit.diff, diffTruncated: edit.diffTruncated,
          })),
        };
      },
    },
  };
}

export function registerRepositoryWriteTools(registry: ReadOnlyToolRegistry, tools: RepositoryWriteTools): void {
  registry.register(tools.proposeFileEdit);
  registry.register(tools.proposeChangeSet);
}

function assertRepositoryBinding(binding: RepositoryToolBinding, context: ReadOnlyToolContext): void {
  if (context.repositoryId !== binding.repositoryId) {
    throw new Error(`Repository tool is bound to repository ${binding.repositoryId}.`);
  }
}

function changeSetToolError(
  failure: { readonly code: string; readonly message: string },
  rollbackStatus: RepositoryChangeSetRollbackStatus,
  rollbackFailedPaths: readonly string[],
): RepositoryChangeSetToolError {
  const rolledBack = rollbackStatus !== "rollback-failed";
  return new RepositoryChangeSetToolError(
    rolledBack ? "CHANGE_SET_FAILED" : "CHANGE_SET_ROLLBACK_FAILED",
    rolledBack
      ? `Change set failed (${failure.code}: ${failure.message}); every applied edit was rolled back.`
      : `Change set failed (${failure.code}: ${failure.message}) and rollback failed for: ${rollbackFailedPaths.join(", ")}.`,
    failure.code,
    rollbackStatus,
    rollbackFailedPaths,
  );
}

/**
 * Runs after preview, so containment and symlink checks have already passed
 * before a file's first lines are read for a generator marker. Every refused
 * path is reported at once, so one resend can confirm them all.
 */
async function assertNotProtected(root: string, edits: readonly { readonly paths: readonly string[]; readonly allowGenerated: boolean }[]): Promise<void> {
  const policy = await loadGeneratedFilePolicy(root);
  const reasons: string[] = [];
  for (const edit of edits) {
    if (edit.allowGenerated) continue;
    for (const path of edit.paths) {
      const found = await policy.classify(path);
      if (found !== null) reasons.push(found.reason);
    }
  }
  if (reasons.length === 0) return;
  throw new RepositoryToolInputError(
    `${reasons.join(" ")} Nothing was changed. If a hand edit is really intended, resend with allowGenerated: true on ${reasons.length === 1 ? "that edit" : "those edits"}.`,
  );
}

/**
 * Turns one validated tool edit into an editor request, reading the current file
 * to derive the concurrency hash. The model never supplies a hash: it cannot
 * know one, and accepting one would let it assert away a concurrent change.
 */
async function toEditRequest(root: string, edit: ProposeChangeSetEditInput): Promise<RepositoryFileEditRequest> {
  if (edit.operation === "create") {
    if (await currentSha256(root, edit.path) !== null) {
      throw new RepositoryToolInputError(`create target already exists: ${edit.path}. Use update instead.`);
    }
    return { operation: "create", path: edit.path, content: edit.content, mustNotExist: true };
  }
  const expectedSha256 = await currentSha256(root, edit.path);
  if (expectedSha256 === null) {
    throw new RepositoryToolInputError(`${edit.operation} target does not exist: ${edit.path}.`);
  }
  if (edit.operation === "update") return { operation: "update", path: edit.path, content: edit.content, expectedSha256 };
  if (edit.operation === "delete") return { operation: "delete", path: edit.path, expectedSha256 };
  if (await currentSha256(root, edit.toPath) !== null) {
    throw new RepositoryToolInputError(`rename destination already exists: ${edit.toPath}.`);
  }
  return { operation: "rename", path: edit.path, toPath: edit.toPath, expectedSha256 };
}

/**
 * Reads the current file (if any) only to compute the hash SafeFileEditor
 * needs to prove it isn't overwriting stale content — never trust this for
 * containment on its own, but it still must not read outside the repository,
 * since preview()'s own (fuller) validation only guards the eventual write.
 */
async function currentSha256(root: string, relativePath: string): Promise<string | null> {
  assertContained(root, relativePath);
  const target = resolve(root, relativePath);
  let bytes: Buffer;
  try {
    bytes = await readFile(target);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // A path whose parent is missing, or that is a directory, is not a readable file either.
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    if (code === "EISDIR") throw new RepositoryToolInputError(`path is a directory: ${relativePath}`);
    throw error;
  }
  if (bytes.includes(0)) throw new RepositoryToolInputError("Cannot edit an existing binary file.");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new RepositoryToolInputError("Existing file is not valid UTF-8.");
  }
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Independent of the editors' own containment checks: defence in depth at the tool boundary. */
function assertContained(root: string, relativePath: string): void {
  if (isAbsolute(relativePath)) throw new RepositoryToolInputError("path must be repository-relative.");
  const fromRoot = relative(root, resolve(root, relativePath));
  if (fromRoot === "" || fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new RepositoryToolInputError("path resolves outside the repository.");
  }
}

function validateProposeFileEditInput(input: unknown): ProposeFileEditInput {
  const object = validateObject(input, ["path", "content", "allowGenerated"]);
  const path = validatePathField(object, "path");
  const content = validateContentField(object, "content");
  return validateAllowGenerated(object) ? { path, content, allowGenerated: true } : { path, content };
}

function validateProposeChangeSetInput(input: unknown): ProposeChangeSetInput {
  const object = validateObject(input, ["edits"]);
  const rawEdits = object["edits"];
  if (!Array.isArray(rawEdits)) throw new RepositoryToolInputError("edits must be an array.");
  if (rawEdits.length === 0) throw new RepositoryToolInputError("edits must contain at least one edit.");
  if (rawEdits.length > MAX_CHANGE_SET_EDITS) {
    throw new RepositoryToolInputError(`edits must contain at most ${MAX_CHANGE_SET_EDITS} edits.`);
  }
  let totalBytes = 0;
  const edits = rawEdits.map((entry): ProposeChangeSetEditInput => {
    const edit = validateChangeSetEdit(entry);
    if (edit.operation === "create" || edit.operation === "update") totalBytes += Buffer.byteLength(edit.content);
    return edit;
  });
  if (totalBytes > MAX_CHANGE_SET_BYTES) {
    throw new RepositoryToolInputError(`change set content exceeds the ${MAX_CHANGE_SET_BYTES}-byte limit.`);
  }
  const claimed = new Set<string>();
  for (const edit of edits) {
    for (const path of edit.operation === "rename" ? [edit.path, edit.toPath] : [edit.path]) {
      const key = path.replaceAll("\\", "/").toLocaleLowerCase();
      if (claimed.has(key)) throw new RepositoryToolInputError(`a change set cannot touch the same path twice: ${path}`);
      claimed.add(key);
    }
  }
  return { edits };
}

function validateChangeSetEdit(input: unknown): ProposeChangeSetEditInput {
  const object = validateObject(input, ["operation", "path", "content", "toPath", "allowGenerated"]);
  const edit = validateChangeSetOperation(object);
  return validateAllowGenerated(object) ? { ...edit, allowGenerated: true } : edit;
}

function validateAllowGenerated(object: Record<string, unknown>): boolean {
  const value = object["allowGenerated"];
  if (value !== undefined && typeof value !== "boolean") throw new RepositoryToolInputError("allowGenerated must be a boolean.");
  return value === true;
}

function validateChangeSetOperation(object: Record<string, unknown>): ProposeChangeSetEditInput {
  const operation = object["operation"];
  if (typeof operation !== "string" || !CHANGE_SET_OPERATIONS.includes(operation as (typeof CHANGE_SET_OPERATIONS)[number])) {
    throw new RepositoryToolInputError(`operation must be one of ${CHANGE_SET_OPERATIONS.join(", ")}.`);
  }
  const path = validatePathField(object, "path");
  if (operation === "create" || operation === "update") {
    if (object["toPath"] !== undefined) throw new RepositoryToolInputError(`toPath is only valid for a rename, not a ${operation}.`);
    const content = validateContentField(object, "content");
    return operation === "create" ? { operation: "create", path, content } : { operation: "update", path, content };
  }
  if (object["content"] !== undefined) throw new RepositoryToolInputError(`content is not valid for a ${operation}.`);
  if (operation === "delete") {
    if (object["toPath"] !== undefined) throw new RepositoryToolInputError("toPath is only valid for a rename, not a delete.");
    return { operation: "delete", path };
  }
  const toPath = validatePathField(object, "toPath");
  if (toPath === path) throw new RepositoryToolInputError("a rename destination must differ from its source.");
  return { operation: "rename", path, toPath };
}

function validateObject(input: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new RepositoryToolInputError("Tool input must be an object.");
  }
  const object = input as Record<string, unknown>;
  const unknownKey = Object.keys(object).find((key) => !allowed.includes(key));
  if (unknownKey !== undefined) throw new RepositoryToolInputError(`Unknown tool input field: ${unknownKey}`);
  return object;
}

function validatePathField(object: Record<string, unknown>, field: string): string {
  const value = object[field];
  if (typeof value !== "string" || value.trim().length === 0 || value.length > MAX_PATH_LENGTH) {
    throw new RepositoryToolInputError(`${field} must be a non-empty string of at most ${MAX_PATH_LENGTH} characters.`);
  }
  return value;
}

function validateContentField(object: Record<string, unknown>, field: string): string {
  const value = object[field];
  if (typeof value !== "string") throw new RepositoryToolInputError(`${field} must be a string.`);
  if (Buffer.byteLength(value) > MAX_CONTENT_BYTES) {
    throw new RepositoryToolInputError(`${field} exceeds the ${MAX_CONTENT_BYTES}-byte limit.`);
  }
  return value;
}
