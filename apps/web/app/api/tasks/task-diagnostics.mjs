/**
 * Safe, structured facts about one task-history write, for the Worker's
 * logs. Never the objective text, a token, or anything else a conversation
 * or a credential could contain — only identifiers an operator can use to
 * find the affected run.
 */
export function taskDiagnostic(event, fields) {
  const record = { atlas: "tasks", event, ...fields };
  try { console.warn(JSON.stringify(record)); } catch { /* logging must never break a dispatch */ }
  return record;
}
