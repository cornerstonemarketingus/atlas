export const CREATE_PROJECT_TOOL = { type: "function", function: {
  name: "workspace_create_project", description: "Create an entirely separate Genesis workspace, scaffold and verify it, then create and push a new GitHub repository under publish.remote policy. Never edits the selected repository. Returns a durable operation receipt, not a completion claim.",
  parameters: { type: "object", properties: {
    name: { type: "string", description: "Lowercase repository slug, at most 63 characters." },
    description: { type: "string", description: "Concrete project idea and acceptance criteria; choose a suitable business if authorized." },
    template: { type: "string", enum: ["web-app", "static-site", "api-service"] },
    visibility: { type: "string", enum: ["private", "public"], description: "Default private. Public only when explicitly requested by the person." },
    host: { type: "string", enum: ["github"] },
  }, required: ["name", "description"], additionalProperties: false },
} };
export const PROJECT_STATUS_TOOL = { type: "function", function: { name: "workspace_project_status", description: "Read actual project creation progress and confirmed repository URL. Use the receipt id; never infer success from dispatch.", parameters: { type: "object", properties: { operationId: { type: "string" } }, required: ["operationId"], additionalProperties: false } } };

export function userWantsPublic(text) {
  const explicit = /\bpublic\s+(?:github\s+)?(?:repo(?:sitory)?|project|app)\b|\b(?:repo(?:sitory)?|project|visibility)\s+(?:should\s+be\s+|must\s+be\s+|is\s+|to\s+|=\s*)?public\b|\b(?:make|keep|set|publish)\s+(?:it|this|the\s+(?:repo(?:sitory)?|project))\s+(?:as\s+)?public\b|\bpublic\s*,?\s*(?:please|visibility)\b/iu.test(text);
  return explicit && !/\b(?:not|never|no)\b.{0,30}\bpublic\b|\bprivate\b/iu.test(text);
}

export function createProjectTools({ create, status, requestId, userMessage }) {
  /** @type {(type: string, data: unknown) => void} */
  const discard = () => {};
  const outcome = (result) => ({ ok: !["unavailable", "failed", "denied", "not-found", "interrupted"].includes(result.status), label: "New project", content: JSON.stringify(result) });
  return { definitions: [CREATE_PROJECT_TOOL, PROJECT_STATUS_TOOL], handlers: {
    workspace_create_project: async (call, { emit = discard } = {}) => {
      const input = JSON.parse(call.function.arguments);
      if (input.visibility === "public" && !userWantsPublic(userMessage)) return outcome({ status: "denied", message: "Public visibility requires an explicit user request. Default to private." });
      const result = await create({ ...input, requestId, visibility: input.visibility ?? "private", host: "github" });
      emit("project", result);
      return outcome(result);
    },
    workspace_project_status: async (call, { emit = discard } = {}) => {
      const { operationId } = JSON.parse(call.function.arguments);
      const result = await status(operationId); emit("project", result); return outcome(result);
    },
  } };
}
