/**
 * Deterministic action classification.
 *
 * The model proposes; this decides. Classification is a pure function of the
 * action and the element it targets — no model call, no heuristic that varies
 * between runs — because the operator's approval prompt has to mean the same
 * thing every time. A rule that sometimes asks and sometimes does not is
 * worse than no rule, since it trains people to click through.
 */
export const ACTION_CLASSES = ["read", "navigate", "input", "sensitive_input", "submit", "transfer", "destructive", "unsupported"];

/** Approval is required for everything that leaves the machine or destroys something. */
const REQUIRES_APPROVAL = new Set(["sensitive_input", "submit", "transfer", "destructive"]);

const SUBMIT_WORDS = /\b(submit|send|post|publish|apply|complete application|place order|checkout|check out|buy|purchase|pay|order now|confirm|continue to payment|sign the|accept and continue|agree and continue)\b/iu;
const DESTRUCTIVE_WORDS = /\b(delete|remove|deactivate|close account|cancel subscription|revoke|wipe|erase|terminate|unsubscribe all)\b/iu;
const TRANSFER_WORDS = /\b(upload|attach|download|export|import|share|transfer|send file)\b/iu;
const SENSITIVE_WORDS = /\b(password|passcode|pin|social security|ssn|national insurance|credit card|card number|cvv|cvc|bank account|routing number|iban|sort code|private key|api key|secret|recovery code|security question|date of birth|passport)\b/iu;

/**
 * Anti-bot and identity walls. Atlas stops and hands the machine back rather
 * than attempting these: working around one is both a policy violation and,
 * on an account the operator owns, a good way to get them locked out.
 */
const HUMAN_REQUIRED = [
  { pattern: /\b(captcha|recaptcha|hcaptcha|cloudflare turnstile|are you a robot|verify you are human|press and hold)\b/iu, reason: "a CAPTCHA or anti-bot challenge" },
  { pattern: /\b(two-factor|2fa|one-time (?:code|password)|otp|authenticator app|verification code sent|security code we sent)\b/iu, reason: "a two-factor authentication prompt" },
  { pattern: /\b(sign in with|log in to continue|session expired|please re-?authenticate|enter your password to continue)\b/iu, reason: "a sign-in or re-authentication prompt" },
  { pattern: /\b(identity verification|upload (?:your )?(?:id|passport|driver'?s licen[cs]e)|liveness check|selfie)\b/iu, reason: "an identity verification step" },
  { pattern: /\b(payment (?:method|details) required|enter card details|3-?d secure)\b/iu, reason: "a payment step" },
];

/** Action types whose `text` is a value being typed, not a visible label. */
const TYPED_VALUE_ACTIONS = new Set(["fill", "type", "select"]);

/** Values that look like a credential even when the field is innocuously named. */
const SENSITIVE_VALUE = /\b(?:\d[ -]?){13,19}\b|\b\d{3}-\d{2}-\d{4}\b|\b(?:sk|gsk|ghp|github_pat|xox[abps])[-_][A-Za-z0-9_-]{8,}\b|-----BEGIN [A-Z ]*PRIVATE KEY-----/u;

export function classifyAction(action, context = {}) {
  const type = String(action?.type ?? "");
  // The typed value is deliberately absent from the label. The label is shown
  // in the approval prompt and written to the audit log, so putting a value
  // here would display and persist the password Atlas is asking to type.
  const label = [
    action?.name,
    action?.label,
    TYPED_VALUE_ACTIONS.has(type) ? null : action?.text,
    action?.intent,
    action?.description,
    context.elementName,
  ]
    .filter(Boolean)
    .join(" ");

  if (["snapshot", "extract", "screenshot", "read", "wait"].includes(type)) return decide("read", "Reads the page without changing it.", label);
  if (type === "navigate") return decide("navigate", "Opens a page.", label);
  if (type === "upload" || type === "download") return decide("transfer", `Moves a file ${type === "upload" ? "off" : "onto"} this machine.`, label);

  if (["fill", "type", "select", "check", "press"].includes(type)) {
    if (SENSITIVE_WORDS.test(label)) return decide("sensitive_input", "Enters sensitive personal or credential data.", label);
    // The value is inspected but never echoed: a card number typed into a
    // field called "notes" is still a card number.
    if (typeof action?.text === "string" && SENSITIVE_VALUE.test(action.text)) {
      return decide("sensitive_input", "The value being entered looks like a credential or card number.", label);
    }
    if (action?.submit === true) return decide("submit", "Types and submits in one step.", label);
    return decide("input", "Fills in a field.", label);
  }

  if (type === "click" || type === "submit") {
    if (DESTRUCTIVE_WORDS.test(label)) return decide("destructive", "Deletes or deactivates something.", label);
    if (TRANSFER_WORDS.test(label)) return decide("transfer", "Moves data off this machine.", label);
    if (SUBMIT_WORDS.test(label) || type === "submit") return decide("submit", "Sends, submits, buys, or publishes.", label);
    return decide("navigate", "An ordinary, reversible click.", label);
  }

  if (type === "done") return decide("read", "Finishes the task.", label);
  return decide("unsupported", `Atlas does not perform '${type}' actions.`, label);
}

function decide(actionClass, reason, label) {
  return {
    actionClass,
    requiresApproval: REQUIRES_APPROVAL.has(actionClass),
    allowed: actionClass !== "unsupported",
    reason,
    // Quoted back in the approval prompt so the operator reads what Atlas read.
    label: label.slice(0, 200),
  };
}

/**
 * Looks for a wall that only a person can get past. Checked against the
 * accessibility snapshot, so it sees the text the page actually exposes.
 */
export function detectHumanRequired(snapshotText) {
  const text = String(snapshotText ?? "");
  for (const { pattern, reason } of HUMAN_REQUIRED) {
    const match = pattern.exec(text);
    if (match) {
      return {
        blocked: true,
        reason,
        evidence: text.slice(Math.max(0, match.index - 60), match.index + 120).replace(/\s+/gu, " ").trim(),
      };
    }
  }
  return { blocked: false, reason: null, evidence: null };
}

/**
 * The one-line summary an operator reads before approving. It names the
 * action, the element, and the site — the three things needed to tell
 * "submit this job application" from "submit this bank transfer".
 */
export function describeForApproval({ classification, url, intent }) {
  const site = safeHost(url);
  return [
    `${classification.actionClass.replaceAll("_", " ")}: ${intent || classification.label || "(no description)"}`,
    `On: ${site}`,
    classification.reason,
  ].join("\n");
}

function safeHost(url) {
  try {
    return new URL(url).host;
  } catch {
    return "(unknown page)";
  }
}
