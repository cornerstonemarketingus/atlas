import { VENDORS } from "../../../../../packages/atlas-inference/src/catalog.mjs";

const PROVIDER_KINDS = new Set(["groq", "openai", "workers-ai", "self-hosted", ...Object.keys(VENDORS)]);
const MODEL_NAME = /^[A-Za-z0-9@._:/-]{1,120}$/u;

/** Public activity is an explicit projection; internal reasoning is never a UI event. */
export function customerEvent(type, data) {
  if (!data || typeof data !== "object") return null;
  if (type === "thinking") return null;
  if (type === "error") return { message: "Atlas could not finish this request. Your work may have been saved; check its status before starting it again." };
  if (type === "meta") return { conversationId: data.conversationId };
  if (type === "delta") return { text: typeof data.text === "string" ? data.text : "" };
  if (type === "tool") {
    const state = ["running", "done", "failed"].includes(data.state) ? data.state : "running";
    return { id: data.id, state, label: { running: "Working on your request", done: "Step completed", failed: "This step needs attention" }[state], ...(data.agentId ? { agentId: data.agentId } : {}) };
  }
  if (type === "agent") {
    const state = ["planning", "running", "verifying", "done", "unverified", "failed", "skipped"].includes(data.state) ? data.state : "running";
    return { id: data.id, parentId: data.parentId ?? null, name: "Atlas", title: "Working on your request", state, depth: Number.isInteger(data.depth) ? data.depth : 0 };
  }
  if (type === "done") {
    // Who wrote the reply, as a provider kind and a model name only (the same
    // facts the non-streaming reply carries), and whether it is unfinished.
    const servedBy = PROVIDER_KINDS.has(data.servedBy?.provider) && typeof data.servedBy?.model === "string" && MODEL_NAME.test(data.servedBy.model)
      ? { servedBy: { provider: data.servedBy.provider, model: data.servedBy.model } } : {};
    const finalization = data.finalization ? { finalization: { status: data.finalization.status === "incomplete" ? "incomplete" : "unknown" } } : {};
    return { conversationId: data.conversationId, stored: data.stored, ...servedBy, ...finalization, ...(data.reply ? { reply: { id: data.reply.id, role: "assistant", content: data.reply.content, createdAt: data.reply.createdAt } } : {}) };
  }
  if (type === "project") {
    const status = ["building", "publishing", "awaiting-approval", "published", "failed", "unavailable", "not-found"].includes(data.status) ? data.status : "building";
    const repository = data.repository;
    const safeRepository = typeof repository?.fullName === "string" && /^[\w.-]+\/[\w.-]+$/u.test(repository.fullName)
      && repository.webUrl === "https://github.com/" + repository.fullName
      ? { fullName: repository.fullName, webUrl: repository.webUrl } : null;
    return { operationId: data.operationId, status, approvalId: data.approvalId, ...(safeRepository ? { repository: safeRepository } : {}),
      message: status === "awaiting-approval" ? "Your approval is required before this action can continue." : "Project status updated. Open your project to review its progress." };
  }
  return null;
}
