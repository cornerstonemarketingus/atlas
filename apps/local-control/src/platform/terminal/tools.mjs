import { assertSchema, defineTool } from "../../../../../packages/atlas-contracts/src/index.mjs";
import { DEFAULT_ALLOWED_ENV_KEYS } from "./terminal-controller.mjs";

/**
 * Tool contracts for the terminal worker.
 *
 * Each tool validates its own input against its declared schema before doing
 * anything, so a caller that skips the gateway's validation still cannot hand
 * the controller an unexpected shape. Schemas stay inside the validator subset
 * in atlas-contracts (additionalProperties:false everywhere) so what is
 * declared is what is enforced.
 */
const WORKSPACE_ID = { type: "string", pattern: "^wks_[0-9a-f]{32}$" };
const COMMAND_ID = { type: "string", pattern: "^tcl_[0-9a-f]{32}$" };

export function terminalToolDefinitions(controller) {
  const envProperties = Object.fromEntries(DEFAULT_ALLOWED_ENV_KEYS.map((key) => [key, { type: "string", maxLength: 4096 }]));

  const tools = [
    {
      name: "terminal.create_workspace",
      description: "Create an isolated scratch workspace directory for a task, optionally seeded with template files.",
      risk: "low",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["tenantId", "taskId"],
        properties: {
          tenantId: { type: "string", minLength: 1, maxLength: 200 },
          taskId: { type: "string", minLength: 1, maxLength: 200 },
          template: {
            type: "object",
            additionalProperties: false,
            properties: { files: { type: "object" } },
          },
        },
      },
      execute: async (input) => controller.createWorkspace(input),
    },
    {
      name: "terminal.run_command",
      description: "Run one allowlisted command (argv array, never a shell) in a workspace and return its exit code and redacted output.",
      risk: "moderate",
      consequential: true,
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["workspaceId", "argv"],
        properties: {
          workspaceId: WORKSPACE_ID,
          argv: { type: "array", minItems: 1, maxItems: 256, items: { type: "string", minLength: 1, maxLength: 32768 } },
          cwd: { type: "string", minLength: 1, maxLength: 1024 },
          timeoutMs: { type: "integer", minimum: 1, maximum: 1_800_000 },
          env: { type: "object", additionalProperties: false, properties: envProperties },
          stdin: { type: "string", maxLength: 1_000_000 },
          network: { type: "boolean" },
        },
      },
      execute: async ({ workspaceId, ...options }) => {
        const handle = await controller.runCommand(workspaceId, options);
        if (handle.status !== "running") return handle;
        return { status: "completed", ...(await handle.result) };
      },
    },
    {
      name: "terminal.cancel",
      description: "Cancel a running terminal command, killing its whole process group.",
      risk: "low",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["commandId"],
        properties: { commandId: COMMAND_ID },
      },
      execute: async ({ commandId }) => controller.cancel(commandId),
    },
    {
      name: "terminal.destroy_workspace",
      description: "Delete a workspace directory and everything in it, cancelling any running commands first.",
      risk: "moderate",
      consequential: true,
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["workspaceId"],
        properties: { workspaceId: WORKSPACE_ID },
      },
      execute: async ({ workspaceId }) => controller.destroyWorkspace(workspaceId),
    },
  ];

  return tools.map(({ execute, ...definition }) => defineTool({
    ...definition,
    execute: async (input) => {
      assertSchema(definition.inputSchema, input, definition.name);
      return execute(input);
    },
  }));
}
