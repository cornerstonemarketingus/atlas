export function validateDeletionDecision(body, requestId) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { error: "A decision payload is required.", status: 400 };
  }
  if (body.action !== "complete" && body.action !== "reject") {
    return { error: "action must be 'complete' or 'reject'.", status: 400 };
  }
  if (body.confirmation !== requestId) {
    return { error: "Enter the exact request ID to confirm this action.", status: 400 };
  }
  const note = typeof body.note === "string" ? body.note.trim() : "";
  if (note.length > 500) return { error: "The audit note must be 500 characters or fewer.", status: 400 };
  if (body.action === "reject" && note.length < 3) {
    return { error: "A short audit note is required when rejecting a request.", status: 400 };
  }
  return { decision: { action: body.action, note } };
}
