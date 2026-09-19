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

/**
 * Consequential wording.
 *
 * These are matched against the element's accessible name and the model's
 * stated intent together. The lists are broad on purpose: a false positive
 * costs one extra tap, and a false negative sends somebody's money.
 *
 * They are also English. That is a real limit, not an oversight — see
 * `additionalConsequentialPatterns` below for how a non-English deployment
 * closes it, and the common non-Latin verbs included here for the most
 * frequent cases.
 */
const SUBMIT_WORDS = new RegExp(
  [
    // Sending and publishing.
    String.raw`\b(submit|send|sending|post|posting|publish|publishing|go live|broadcast)\b`,
    String.raw`\b(tweet|xeet|toot|share to|post to)\b`,
    // Applying and booking.
    String.raw`\b(apply|applying|complete application|book|booking|reserve|reservation|enroll|enrol|register now|sign up now)\b`,
    // Buying and paying. `pay` must also catch payment/paying/repay.
    String.raw`\b(buy|purchase|purchasing|order|checkout|check out|basket|cart)\b`,
    String.raw`\b(pay|pays|paying|payment|payments|authori[sz]e|authori[sz]ation|charge my|place .{0,12}order)\b`,
    String.raw`\b(donate|donation|tip|pledge|subscribe now|start subscription)\b`,
    // Money movement.
    String.raw`\b(transfer|withdraw|withdrawal|deposit|wire|remit|payout|send money)\b`,
    // Agreement and signature.
    String.raw`\b(confirm|confirming|sign|signing|signature|accept|agree|consent|authorise)\b`,
    // Common non-Latin and non-English verbs for the most frequent cases.
    // Not exhaustive, and not a substitute for configuring your own.
    String.raw`(送信|提交|确认|購入|購買|支付|付款|삭제|제출|결제)`,
    String.raw`\b(enviar|env[ií]o|absenden|senden|envoyer|invia|inviare|verzenden|skicka|wyślij|отправить|подтвердить|оплатить)\b`,
    String.raw`\b(comprar|kaufen|acheter|comprare|bestellen|beställ|zamów|купить)\b`,
  ].join("|"),
  "iu",
);

const DESTRUCTIVE_WORDS = new RegExp(
  [
    String.raw`\b(delete|deleting|remove|removing|deactivate|disable account|close account|cancel subscription)\b`,
    String.raw`\b(revoke|wipe|erase|erasing|destroy|terminate|purge|unsubscribe all|reset everything|factory reset)\b`,
    String.raw`(削除|刪除|删除|삭제|löschen|supprimer|eliminar|удалить)`,
  ].join("|"),
  "iu",
);

const TRANSFER_WORDS = new RegExp(
  [
    String.raw`\b(upload|uploading|attach|attachment|download|downloading|export|exporting|import|importing)\b`,
    String.raw`\b(share|sharing|transfer|send file|send a copy|email a copy|sync to)\b`,
  ].join("|"),
  "iu",
);

/**
 * Extra patterns an operator can add for their own language or their own
 * applications. Matched exactly like the built-ins, and only ever able to
 * raise the risk class — there is deliberately no way to configure something
 * *down* to not needing approval.
 */
let additionalConsequentialPatterns = [];

export function setAdditionalConsequentialPatterns(patterns) {
  additionalConsequentialPatterns = (patterns ?? []).map((pattern) => (pattern instanceof RegExp ? pattern : new RegExp(String(pattern), "iu")));
  return additionalConsequentialPatterns.length;
}

function matchesAdditional(label) {
  return additionalConsequentialPatterns.some((pattern) => pattern.test(label));
}
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
    if (matchesAdditional(label)) return decide("submit", "Matches a consequential pattern configured for this machine.", label);
    // A control with no readable words — empty, or only an arrow or an icon
    // glyph — is not "an ordinary click", it is an unknown one, and the
    // classifier has nothing to go on. Icon-only buttons are exactly where a
    // send or a purchase hides.
    //
    // The cost is real: a bare "→" on a paginated list now asks. That is the
    // right direction to be wrong in, and the prompt says plainly that the
    // control is unreadable rather than inventing a description. An operator
    // who hits this often on a trusted site should be given a named element
    // by that site, not a quieter classifier here.
    if (!/[\p{L}\p{N}]/u.test(label)) {
      return decide("submit", "This control has no readable label, so Atlas cannot tell what it does.", label);
    }
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
