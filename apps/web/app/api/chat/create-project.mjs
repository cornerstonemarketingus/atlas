import { PROJECT_TOOL, projectRequestsFromCalls } from "./atlas-knowledge.mjs";
import { validateGenesisRequest } from "../projects/genesis/service.mjs";

/**
 * The `create_project` chat tool only prepares a repository proposal.
 *
 * Actual repository creation stays behind the explicit confirmation card in
 * the chat UI; the model may suggest a starter, name and description, but it
 * does not create anything directly from the tool call.
 */
export function createProjectTool() {
  async function handler(call) {
    const parsed = projectRequestsFromCalls([call]);
    if (parsed.errors.length) {
      return { ok: false, label: "Project proposal needs more detail", content: parsed.errors.join("\n\n") };
    }
    const validated = validateGenesisRequest(parsed.requests[0]);
    if ("error" in validated) {
      return { ok: false, label: "Project proposal is invalid", content: validated.error };
    }
    const proposal = { kind: "project_genesis", ...validated.project };
    return {
      ok: true,
      label: `Project proposal ready: ${proposal.name}`,
      content: [
        "A confirmation card is ready for this repository proposal.",
        `Name: ${proposal.name}`,
        `Template: ${proposal.template}`,
        `Description: ${proposal.description}`,
        "Tell the person Atlas can create it after they confirm; do not claim the repository exists yet.",
      ].join("\n"),
      proposal,
    };
  }

  return { definition: PROJECT_TOOL, handler: Object.assign(handler, { pending: "Preparing a repository proposal…" }) };
}
