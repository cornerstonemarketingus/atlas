const consequential = /\b(submit|send|publish|post|purchase|buy|place order|apply(?: now)?|complete application|launch|pay|transfer|delete|remove account|confirm|save password|change password|security setting|enroll)\b/iu;
const sensitive = /\b(password|passcode|social security|ssn|credit card|card number|cvv|bank account|routing number|private key|secret|recovery code)\b/iu;

export function actionRisk(action) {
  const label = [action.name, action.label, action.selector, action.text].filter(Boolean).join(" ");
  if (["fill", "select", "check", "press"].includes(action.type) && sensitive.test(label)) return { decision: "ask", reason: "Enter sensitive information" };
  if (action.type === "click" && consequential.test(label)) return { decision: "ask", reason: `Activate “${String(action.name ?? action.text ?? "consequential action").slice(0, 120)}”` };
  if (["upload", "download", "clipboard", "payment"].includes(action.type)) return { decision: "ask", reason: `${action.type} data` };
  if (["navigate", "click", "fill", "select", "check", "press", "wait", "extract", "done"].includes(action.type)) return { decision: "allow", reason: "Reversible browser interaction" };
  return { decision: "deny", reason: "Unsupported browser action" };
}

export function validateAction(action) {
  if (!action || typeof action !== "object") throw new Error("The model returned an invalid action.");
  if (typeof action.type !== "string" || action.type.length > 32) throw new Error("The model returned an invalid action type.");
  for (const key of ["name", "label", "text", "value", "url", "key"]) {
    if (action[key] !== undefined && (typeof action[key] !== "string" || action[key].length > 4000)) throw new Error(`Invalid action field: ${key}`);
  }
  return action;
}
