import { safeProjectReceipt } from "../../chat/project-receipts.mjs";

/** Reserve the recoverable id before any external side effect. D1 failure fails closed. */
export async function reserveProjectReceipt(d1, scope, conversationId, operationId) {
  const receipt = safeProjectReceipt({ operationId });
  if (!receipt || !scope?.tenantId || !scope?.principal || !conversationId) throw new Error("PROJECT_HISTORY_REQUIRED");
  const result = await d1.prepare(`INSERT INTO run_events (id, conversation_id, requested_by, kind, label, detail, created_at)
    SELECT ?, id, requested_by, 'project', 'New project receipt', ?, ? FROM conversations
    WHERE id = ? AND tenant_id = ? AND requested_by = ? AND archived_at IS NULL
    ON CONFLICT(id) DO UPDATE SET detail = excluded.detail
    WHERE run_events.conversation_id = excluded.conversation_id AND run_events.requested_by = excluded.requested_by`)
    .bind(`project:${conversationId}:${operationId}`, JSON.stringify(receipt), new Date().toISOString(), conversationId, scope.tenantId, scope.principal).run();
  if (!(result?.meta?.changes > 0)) throw new Error("PROJECT_HISTORY_REQUIRED");
  return receipt;
}

export function recoverableProjectCreator({ create, reserve }) {
  return async (input) => {
    try { await reserve(input.requestId); }
    catch { return { status: "unavailable", message: "Project creation requires saved conversation history. Reopen a saved chat and try again. No creation request was sent." }; }
    return create(input);
  };
}

/** Legacy direct callers without a thread receive a new owned conversation. */
export async function createProjectConversation(d1, scope, conversationId) {
  if (!scope?.tenantId || !scope?.principal) throw new Error("PROJECT_HISTORY_REQUIRED");
  await d1.prepare("INSERT INTO conversations (id, tenant_id, requested_by, title, repository, branch) VALUES (?, ?, ?, 'New project', '', 'main')")
    .bind(conversationId, scope.tenantId, scope.principal).run();
}
