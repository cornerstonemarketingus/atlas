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
    // `\b` is ASCII-only, so a Cyrillic alternative inside one can never
    // match. Non-Latin verbs go in an unanchored group.
    String.raw`(отправить|подтвердить|оплатить|купить|удалить|перевести)`,
    String.raw`\b(enviar|env[ií]o|absenden|senden|envoyer|invia|inviare|verzenden|skicka|wyślij)\b`,
    String.raw`\b(comprar|kaufen|acheter|comprare|bestellen|beställ|zamów)\b`,
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
const SENSITIVE_WORDS = new RegExp(
  [
    String.raw`\b(password|passphrase|passcode|\bpin\b|one-?time code|otp|mfa code|2fa code|verification code|security code)\b`,
    String.raw`\b(seed phrase|recovery phrase|mnemonic|private key|api key|secret key|access token|recovery code)\b`,
    String.raw`\b(social security|ssn|national insurance|tax id|passport|driver'?s licen[cs]e|date of birth)\b`,
    String.raw`\b(credit card|card number|cvv|cvc|expiry|expiration date|bank account|account number|routing number|iban|sort code|swift)\b`,
    String.raw`\b(security question|mother'?s maiden name)\b`,
    // Non-Latin and non-English, unanchored for the same reason as above.
    String.raw`(パスワード|密码|密碼|비밀번호|암호|пароль|секрет)`,
    String.raw`\b(passwort|kennwort|contrase[nñ]a|mot de passe|senha|wachtwoord|lösenord|hasło|parola)\b`,
  ].join("|"),
  "iu",
);

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
/**
 * Actions whose `text` is a value the operator is typing, and which therefore
 * must never reach the label. A `select` is deliberately NOT here: its text is
 * the option chosen from a list the page already displays, so it is visible
 * either way — and excluding it hid "Delete all messages" from every list.
 */
const TYPED_VALUE_ACTIONS = new Set(["fill", "type"]);

/** Values that look like a credential even when the field is innocuously named. */
const SENSITIVE_VALUE = /\b(?:\d[ -]?){13,19}\b|\b\d{3}-\d{2}-\d{4}\b|\b(?:sk|gsk|ghp|github_pat|xox[abps])[-_][A-Za-z0-9_-]{8,}\b|-----BEGIN [A-Z ]*PRIVATE KEY-----/u;

/**
 * Confusable letters, folded to their Latin lookalike.
 *
 * "Pаy" with a Cyrillic а renders identically to "Pay" and defeated every
 * word list. The full Unicode confusables table is enormous; these are the
 * letters that actually appear in the Latin alphabet's homoglyph set, which
 * is what a label-spoofing attack uses.
 */
const CONFUSABLES = new Map(Object.entries({
  "\u0430": "a", "\u0435": "e", "\u043e": "o", "\u0440": "p", "\u0441": "c", "\u0445": "x",
  "\u0443": "y", "\u0456": "i", "\u0458": "j", "\u04bb": "h", "\u0501": "d", "\u0500": "d",
  "\u03bf": "o", "\u03b1": "a", "\u03c1": "p", "\u03c5": "u", "\u03bd": "v", "\u0392": "b",
  "\u2010": "-", "\u2011": "-", "\u2012": "-", "\u2013": "-", "\u2014": "-",
}));

/**
 * Normalizes a label before any pattern runs.
 *
 * A zero-width space, a soft hyphen or a single Cyrillic lookalike inside a
 * keyword renders identically in the browser and slipped past every list.
 * The page controls this string, so it has to be folded to a canonical form
 * before it is matched — and `\s` in JavaScript does not cover U+200B,
 * U+200D or U+00AD, so trimming whitespace is not enough.
 */
export function normalizeLabel(value, { foldConfusables = true } = {}) {
  const text = String(value ?? "").normalize("NFKC");
  let out = "";
  for (const character of text) {
    // Format characters (Cf) are invisible and carry no meaning in a label.
    if (/\p{Cf}/u.test(character)) continue;
    out += (foldConfusables ? CONFUSABLES.get(character) : undefined) ?? character;
  }
  return out.replace(/\s+/gu, " ").trim();
}

/**
 * Both readings of a label, because the two defences work against each other:
 * folding Cyrillic lookalikes to Latin catches "Pаy $49", and it also turns a
 * genuine Cyrillic word like "Отправить" into mixed-script gibberish that the
 * Cyrillic patterns can no longer match. A pattern matching EITHER form is
 * consequential — this is a union, so folding can only ever add matches.
 */
function matchesAny(pattern, subject) {
  return pattern.test(subject.folded) || pattern.test(subject.raw);
}

export function classifyAction(action, context = {}) {
  const type = String(action?.type ?? "");
  // The typed value is deliberately absent from the label. The label is shown
  // in the approval prompt and written to the audit log, so putting a value
  // here would display and persist the password Atlas is asking to type.
  const rawLabel = normalizeLabel([
    action?.name,
    action?.label,
    TYPED_VALUE_ACTIONS.has(type) ? null : action?.text,
    action?.intent,
    action?.description,
    context.elementName,
  ].filter(Boolean).join(" "), { foldConfusables: false });
  const label = normalizeLabel(rawLabel);

  // A destination is as consequential as a button: a one-click GET link can
  // delete an account or unsubscribe everybody. The path and query are read,
  // the rest of the URL is not — a hostname is not an instruction.
  const rawDestination = typeof action?.url === "string" ? normalizeLabel(readableUrlParts(action.url), { foldConfusables: false }) : "";
  const destination = { raw: rawDestination, folded: normalizeLabel(rawDestination) };
  // What the word lists actually run over. Everything the page or the model
  // supplied, together, so no single attacker-chosen field decides the class.
  const subject = { raw: `${rawLabel} ${rawDestination}`.trim(), folded: `${label} ${destination.folded}`.trim() };

  if (["snapshot", "extract", "screenshot", "read", "wait"].includes(type)) return decide("read", "Reads the page without changing it.", label);
  if (type === "upload" || type === "download") return decide("transfer", `Moves a file ${type === "upload" ? "off" : "onto"} this machine.`, label);

  // Consequence is a property of what is being acted on, not of which verb
  // the model chose. A dropdown reading "Delete all messages" is destructive
  // whether it is driven by a click, a select or a keypress, and a link to
  // `/account/delete?confirm=yes` is destructive as a navigation.
  if (matchesAny(DESTRUCTIVE_WORDS, subject)) return decide("destructive", "Deletes or deactivates something.", label);

  if (["fill", "type", "select", "check", "press"].includes(type)) {
    if (matchesAny(SENSITIVE_WORDS, { raw: rawLabel, folded: label })) return decide("sensitive_input", "Enters sensitive personal or credential data.", label);
    // The value is inspected but never echoed: a card number typed into a
    // field called "notes" is still a card number.
    if (typeof action?.text === "string" && SENSITIVE_VALUE.test(action.text)) {
      return decide("sensitive_input", "The value being entered looks like a credential or card number.", label);
    }
    if (matchesAny(TRANSFER_WORDS, subject)) return decide("transfer", "Moves data off this machine.", label);
    if (matchesAny(SUBMIT_WORDS, subject) || matchesAdditional(subject.folded) || matchesAdditional(subject.raw)) return decide("submit", "Sends, submits, buys, or publishes.", label);
    if (action?.submit === true) return decide("submit", "Types and submits in one step.", label);
    return decide("input", "Fills in a field.", label);
  }

  if (type === "navigate") {
    // Deliberately NOT the full submit list. Ordinary page paths contain
    // "apply", "order", "book" and "post" constantly (/jobs/apply,
    // /orders/123, /blog/post/4), and prompting on those would train the
    // operator to approve without reading — which costs more than it buys.
    // What matters is a one-click GET that *performs* something: an action
    // verb in the path, or a confirmation token in the query.
    if (URL_ACTION_DESTRUCTIVE.test(destination.raw)) {
      return decide("destructive", "Opens a link that deletes or deactivates something.", label || rawDestination);
    }
    if (URL_ACTION_SUBMIT.test(destination.raw)) {
      return decide("submit", "Opens a link that performs an action rather than showing a page.", label || rawDestination);
    }
    return decide("navigate", "Opens a page.", label);
  }

  if (type === "click" || type === "submit") {
    if (matchesAny(TRANSFER_WORDS, subject)) return decide("transfer", "Moves data off this machine.", label);
    if (matchesAny(SUBMIT_WORDS, subject) || type === "submit") return decide("submit", "Sends, submits, buys, or publishes.", label);
    if (matchesAdditional(subject.folded) || matchesAdditional(subject.raw)) return decide("submit", "Matches a consequential pattern configured for this machine.", label);
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

/**
 * One-click GET links that *do* something.
 *
 * A destination is only treated as consequential when it looks like an action
 * endpoint — an action verb as its own path segment, or a confirmation token
 * in the query. `readableUrlParts` has already turned separators into spaces,
 * so a segment reads as a standalone word.
 */
const URL_ACTION_DESTRUCTIVE = /(?:^|\s)(delete|remove|revoke|deactivate|unsubscribe|close account|destroy|purge|wipe)(?:\s|$)/iu;
const URL_ACTION_SUBMIT = /(?:^|\s)(confirm|approve|authori[sz]e|execute|pay|payment|checkout|transfer|withdraw|send|submit|unsubscribe)(?:\s|$)/iu;

/**
 * The parts of a URL worth classifying: the path and the query, with
 * separators turned into spaces so `/account/delete?confirm=yes` reads as
 * words. The host is excluded — a domain name is not a statement of intent.
 */
function readableUrlParts(candidate) {
  try {
    const url = new URL(candidate);
    return `${decodeURIComponent(url.pathname)} ${decodeURIComponent(url.search)}`.replace(/[/?&=_+.-]+/gu, " ");
  } catch {
    return "";
  }
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
