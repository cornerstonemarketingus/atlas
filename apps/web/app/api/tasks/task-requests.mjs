import { newCorrelationId, CORRELATION_HEADER } from "./correlation.mjs";

function reply(body, status, correlationId) {
  return Response.json(body, { status, headers: { "cache-control": "no-store", ...(correlationId ? { [CORRELATION_HEADER]: correlationId } : {}) } });
}

async function pendingRequest(d1, scope, correlationId) {
  const { results } = await d1.prepare("SELECT task_id, conversation_id, execution_provider, merge_policy, dispatch_state FROM tasks WHERE tenant_id = ? AND requested_by = ? AND correlation_id = ? LIMIT 2")
    .bind(scope.tenantId, scope.principal, correlationId).all();
  if (results.length !== 1) return reply({ requestState: "pending", correlationId, message: "Your request is saved. Check progress before starting another request." }, 202, correlationId);
  const task = results[0];
  return reply({ requestState: "pending", correlationId, taskId: task.task_id, conversationId: task.conversation_id, runner: task.execution_provider, mergePolicy: task.merge_policy, recorded: true,
    status: task.dispatch_state === "rejected" ? "dispatch-rejected" : task.dispatch_state === "dispatched" ? "dispatched" : "dispatch-unknown",
    message: "Atlas found your saved task without submitting it again." }, task.dispatch_state === "rejected" ? 502 : 202, correlationId);
}

/** Unique admission precedes the normal route, including billing. No lease takeover. */
export async function executeTaskRequest(d1, scope, { key, fingerprint }, execute) {
  const correlationId = newCorrelationId();
  let admission;
  try {
    admission = await d1.prepare("INSERT INTO task_requests (tenant_id, requested_by, request_key, fingerprint, correlation_id) VALUES (?, ?, ?, ?, ?) ON CONFLICT (tenant_id, requested_by, request_key) DO NOTHING")
      .bind(scope.tenantId, scope.principal, key, fingerprint, correlationId).run();
    if (admission.success === false) throw new Error("Admission failed");
    if (admission.meta?.changes !== 1) {
      const saved = await d1.prepare("SELECT fingerprint, correlation_id, state, response_status, response_json FROM task_requests WHERE tenant_id = ? AND requested_by = ? AND request_key = ?")
        .bind(scope.tenantId, scope.principal, key).first();
      if (!saved) throw new Error("Admission unavailable");
      if (saved.fingerprint !== fingerprint) return reply({ message: "This request key already belongs to a different request." }, 409);
      if (saved.state === "completed") return reply({ ...JSON.parse(saved.response_json), replayed: true }, saved.response_status, saved.correlation_id);
      return await pendingRequest(d1, scope, saved.correlation_id);
    }
  } catch {
    return reply({ message: "Saved request status is unavailable. Retry this same request when storage is available." }, 503);
  }

  let response;
  let body;
  try {
    response = await execute(correlationId);
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > 16384) throw new Error("Response too large");
    body = JSON.parse(text);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Invalid response");
  } catch {
    // The existing task route may have completed before interruption. Never replay it.
    return reply({ requestState: "pending", correlationId, message: "Your request is saved, but its outcome is unconfirmed. Check progress before starting another request." }, 202, correlationId);
  }
  body = { ...body, requestState: "completed", correlationId };
  try {
    const saved = await d1.prepare("UPDATE task_requests SET state = 'completed', response_status = ?, response_json = ? WHERE tenant_id = ? AND requested_by = ? AND request_key = ? AND fingerprint = ? AND correlation_id = ? AND state = 'reserved'")
      .bind(response.status, JSON.stringify(body), scope.tenantId, scope.principal, key, fingerprint, correlationId).run();
    if (saved.success === false || saved.meta?.changes !== 1) throw new Error("Receipt unavailable");
  } catch {
    // Keep the admission permanently reserved, even if the outcome receipt cannot be saved.
    body.requestState = "pending";
  }
  return reply(body, response.status, correlationId);
}
