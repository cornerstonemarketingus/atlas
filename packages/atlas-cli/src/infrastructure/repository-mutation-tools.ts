import type {
  RepositoryChangeSetPlan,
  RepositoryChangeSetResult,
  RepositoryChangeSetEditor,
} from "../domain/repository-change-set.js";
import type {
  RepositoryFileEditPlan,
  RepositoryFileEditRequest,
  RepositoryFileEditor,
} from "../domain/repository-file-edit.js";
import type { RepositoryToolAdapter, RepositoryToolOutput } from "../domain/repository-tool.js";
import type { ValidationProfileRunner } from "./validation-profile-runner.js";

export interface RepositoryMutationToolAdaptersContext {
  readonly repositoryRoot: string;
  readonly repositoryId: string;
}

export interface RepositoryMutationToolAdaptersServices {
  readonly fileEditor: RepositoryFileEditor;
  readonly changeSetEditor: RepositoryChangeSetEditor;
  readonly validationRunner?: ValidationProfileRunner;
}

/**
 * Creates repository mutation tool adapters for file create, update, change-set
 * operations, and validation. All adapters are bounded, audited, and approval-gated.
 */
export function createRepositoryMutationTools(
  context: RepositoryMutationToolAdaptersContext,
  services: RepositoryMutationToolAdaptersServices,
): Map<string, RepositoryToolAdapter> {
  return new Map([
    [
      "atlas/file-create-plan",
      {
        name: "atlas/file-create-plan",
        description: "Preview creating a new file in the repository.",
        parameters: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Repository-relative path for the new file (e.g., 'src/new-module.ts').",
            },
            content: {
              type: "string",
              description: "UTF-8 text content for the new file.",
            },
          },
          required: ["path", "content"],
        },
        handler: async (input: Record<string, unknown>): Promise<RepositoryToolOutput> => {
          const path = String(input.path ?? "");
          const content = String(input.content ?? "");
          if (!path || !content) {
            return { status: "error", error: "path and content are required and must be non-empty" };
          }
          try {
            const plan = await services.fileEditor.preview(context.repositoryRoot, {
              operation: "create",
              path,
              content,
              mustNotExist: true,
            });
            return {
              status: "success",
              data: {
                operation: "create",
                path: plan.path,
                beforeSha256: plan.beforeSha256,
                afterSha256: plan.afterSha256,
                diff: plan.diff,
                diffTruncated: plan.diffTruncated,
                planDigest: plan.planDigest,
              },
            };
          } catch (error: unknown) {
            return {
              status: "error",
              error: error instanceof Error ? error.message : "Failed to plan file creation.",
            };
          }
        },
      },
    ],
    [
      "atlas/file-update-plan",
      {
        name: "atlas/file-update-plan",
        description: "Preview updating an existing file in the repository.",
        parameters: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Repository-relative path to the file to update.",
            },
            content: {
              type: "string",
              description: "New UTF-8 text content for the file.",
            },
            expectedSha256: {
              type: "string",
              description: "Current SHA-256 hash of the file (required for optimistic concurrency control).",
            },
          },
          required: ["path", "content", "expectedSha256"],
        },
        handler: async (input: Record<string, unknown>): Promise<RepositoryToolOutput> => {
          const path = String(input.path ?? "");
          const content = String(input.content ?? "");
          const expectedSha256 = String(input.expectedSha256 ?? "");
          if (!path || !content || !expectedSha256) {
            return { status: "error", error: "path, content, and expectedSha256 are required" };
          }
          try {
            const plan = await services.fileEditor.preview(context.repositoryRoot, {
              operation: "update",
              path,
              content,
              expectedSha256,
            });
            return {
              status: "success",
              data: {
                operation: "update",
                path: plan.path,
                beforeSha256: plan.beforeSha256,
                afterSha256: plan.afterSha256,
                diff: plan.diff,
                diffTruncated: plan.diffTruncated,
                planDigest: plan.planDigest,
              },
            };
          } catch (error: unknown) {
            return {
              status: "error",
              error: error instanceof Error ? error.message : "Failed to plan file update.",
            };
          }
        },
      },
    ],
    [
      "atlas/change-set-plan",
      {
        name: "atlas/change-set-plan",
        description: "Preview creating or updating multiple files as a single atomic change set.",
        parameters: {
          type: "object",
          properties: {
            operations: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  operation: { type: "string", enum: ["create", "update"] },
                  path: { type: "string" },
                  content: { type: "string" },
                  expectedSha256: { type: "string" },
                },
                required: ["operation", "path", "content"],
              },
              description: "Ordered list of file create/update operations.",
            },
          },
          required: ["operations"],
        },
        handler: async (input: Record<string, unknown>): Promise<RepositoryToolOutput> => {
          const operations = Array.isArray(input.operations) ? input.operations : [];
          if (operations.length === 0) {
            return { status: "error", error: "At least one operation is required" };
          }
          try {
            const requests: RepositoryFileEditRequest[] = operations.map((op: unknown) => {
              const opObj = op as Record<string, unknown>;
              return {
                operation: String(opObj.operation) as "create" | "update",
                path: String(opObj.path ?? ""),
                content: String(opObj.content ?? ""),
                expectedSha256: opObj.operation === "update" ? String(opObj.expectedSha256 ?? "") : undefined,
                mustNotExist: opObj.operation === "create" ? true : undefined,
              };
            });
            const plan = await services.changeSetEditor.preview(context.repositoryRoot, requests);
            return {
              status: "success",
              data: {
                root: plan.root,
                editsCount: plan.edits.length,
                edits: plan.edits.map((edit) => ({
                  operation: edit.operation,
                  path: edit.path,
                  beforeSha256: edit.beforeSha256,
                  afterSha256: edit.afterSha256,
                  diffTruncated: edit.diffTruncated,
                  planDigest: edit.planDigest,
                })),
                changeSetDigest: plan.changeSetDigest,
              },
            };
          } catch (error: unknown) {
            return {
              status: "error",
              error: error instanceof Error ? error.message : "Failed to plan change set.",
            };
          }
        },
      },
    ],
  ]);
}

/**
 * Registers mutation tool adapters into a policy-enforced registry.
 */
export function registerRepositoryMutationTools(
  registry: { register: (adapter: RepositoryToolAdapter) => void },
  tools: Map<string, RepositoryToolAdapter>,
): void {
  for (const tool of tools.values()) {
    registry.register(tool);
  }
}
