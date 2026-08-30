import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import type { ReadOnlyToolContext, ReadOnlyToolDefinition, ReadOnlyToolRegistry } from "../domain/read-only-tool-registry.js";
import type { RepositoryFileEditor } from "../domain/repository-file-edit.js";
import { RepositoryToolInputError, type RepositoryToolBinding } from "./repository-read-only-tools.js";

const MAX_PATH_LENGTH = 4_096;
const MAX_CONTENT_BYTES = 1024 * 1024;

export interface ProposeFileEditInput {
  readonly path: string;
  readonly content: string;
}

export interface ProposeFileEditOutput {
  readonly path: string;
  readonly operation: "create" | "update";
  readonly diff: string;
  readonly diffTruncated: boolean;
}

export interface RepositoryWriteToolServices {
  readonly editor: RepositoryFileEditor;
}

export interface RepositoryWriteTools {
  readonly proposeFileEdit: ReadOnlyToolDefinition<ProposeFileEditInput, ProposeFileEditOutput>;
}

/**
 * Creates the one write tool an agent may use, permanently bound to one
 * repository working tree. It previews and immediately applies a single-file
 * create/update through the digest-bound SafeRepositoryFileEditor rather than
 * pausing for a per-edit approval: the real safety boundary here is that this
 * working tree is disposable (a fresh CI checkout) and reaches anything
 * shared only via a pull request a human or CI gate reviews before merge.
 */
export function createRepositoryWriteTools(
  binding: RepositoryToolBinding,
  services: RepositoryWriteToolServices,
): RepositoryWriteTools {
  if (binding.repositoryId.trim().length === 0 || binding.repositoryRoot.trim().length === 0) {
    throw new Error("Repository tool bindings require a repository ID and root.");
  }

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
        const plan = await services.editor.preview(binding.repositoryRoot, {
          operation: expectedSha256 === null ? "create" : "update",
          path: input.path,
          content: input.content,
          ...(expectedSha256 === null ? { mustNotExist: true as const } : { expectedSha256 }),
        });
        await services.editor.apply(plan, { approved: true, planDigest: plan.planDigest });
        return { path: plan.path, operation: plan.operation, diff: plan.diff, diffTruncated: plan.diffTruncated };
      },
    },
  };
}

export function registerRepositoryWriteTools(registry: ReadOnlyToolRegistry, tools: RepositoryWriteTools): void {
  registry.register(tools.proposeFileEdit);
}

function assertRepositoryBinding(binding: RepositoryToolBinding, context: ReadOnlyToolContext): void {
  if (context.repositoryId !== binding.repositoryId) {
    throw new Error(`Repository tool is bound to repository ${binding.repositoryId}.`);
  }
}

/**
 * Reads the current file (if any) only to compute the hash SafeFileEditor
 * needs to prove it isn't overwriting stale content — never trust this for
 * containment on its own, but it still must not read outside the repository,
 * since preview()'s own (fuller) validation only guards the eventual write.
 */
async function currentSha256(root: string, relativePath: string): Promise<string | null> {
  if (isAbsolute(relativePath)) throw new RepositoryToolInputError("path must be repository-relative.");
  const target = resolve(root, relativePath);
  const fromRoot = relative(root, target);
  if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new RepositoryToolInputError("path resolves outside the repository.");
  }
  let bytes: Buffer;
  try {
    bytes = await readFile(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
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

function validateProposeFileEditInput(input: unknown): ProposeFileEditInput {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new RepositoryToolInputError("Tool input must be an object.");
  }
  const object = input as Record<string, unknown>;
  const unknownKey = Object.keys(object).find((key) => key !== "path" && key !== "content");
  if (unknownKey !== undefined) throw new RepositoryToolInputError(`Unknown tool input field: ${unknownKey}`);

  const path = object["path"];
  if (typeof path !== "string" || path.trim().length === 0 || path.length > MAX_PATH_LENGTH) {
    throw new RepositoryToolInputError(`path must be a non-empty string of at most ${MAX_PATH_LENGTH} characters.`);
  }
  const content = object["content"];
  if (typeof content !== "string") throw new RepositoryToolInputError("content must be a string.");
  if (Buffer.byteLength(content) > MAX_CONTENT_BYTES) {
    throw new RepositoryToolInputError(`content exceeds the ${MAX_CONTENT_BYTES}-byte limit.`);
  }
  return { path, content };
}
