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
  if (type === "done") return { conversationId: data.conversationId, stored: data.stored, ...(data.reply ? { reply: { id: data.reply.id, role: "assistant", content: data.reply.content, createdAt: data.reply.createdAt } } : {}) };
  if (type === "project") {
    const status = ["building", "publishing", "awaiting-approval", "published", "ready", "failed", "unavailable", "not-found", "denied", "interrupted", "blocked"].includes(data.status) ? data.status : "building";
    const repository = data.repository;
    const safeRepository = typeof repository?.fullName === "string" && /^[\w.-]+\/[\w.-]+$/u.test(repository.fullName)
      && repository.webUrl === "https://github.com/" + repository.fullName
      ? { fullName: repository.fullName, webUrl: repository.webUrl } : null;
    const previewUrl = typeof data.previewUrl === "string"
      && /^\/preview\/gen_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(data.previewUrl)
      && data.previewUrl === `/preview/${data.operationId}` ? data.previewUrl : null;
    const message = ["failed", "unavailable", "denied", "not-found", "interrupted"].includes(status)
      ? "Atlas could not start or complete this project. No successful creation is confirmed."
      : status === "ready" ? "Your website preview is ready. Nothing is published; the preview does not send enquiries."
      : status === "blocked" ? "Project creation needs your input before it can continue."
      : status === "awaiting-approval" ? "Your approval is required before this action can continue."
      : "Project status updated. Open your project to review its progress.";
    return { operationId: data.operationId, status, approvalId: data.approvalId, ...(safeRepository ? { repository: safeRepository } : {}),
      ...(status === "ready" && previewUrl ? { previewUrl } : {}), message };
  }
  return null;
}
