import { createHash } from "node:crypto";

import { detectInjection } from "../platform/mcp/gateway.mjs";

/**
 * Opportunities: the one record shape every source is normalized into, and the
 * rules that decide what Atlas may do about it.
 *
 * Three rules are enforced here, in code, not asked of the model:
 *
 * - Nothing is invented. The URL is the one the search returned (a model
 *   cannot add one), a pay figure must appear in the page it came from, and a
 *   record needs at least one quotation that is really on that page. Anything
 *   else a model claims is dropped, and a model's application answers are
 *   never stored at all: Atlas asks the owner instead.
 * - Classification only tightens. Page text and the model's flags are
 *   combined, so a model that misses a CAPTCHA, an identity check or a fee
 *   cannot relax what the text says.
 * - Execution class is AUTO (Atlas may act without asking), APPROVAL_REQUIRED
 *   (Atlas prepares it, the owner approves the exact record) or MANUAL (the
 *   owner must do it). Anything that sends information to a third party or
 *   commits the owner is never AUTO.
 */

export const OPPORTUNITY_KINDS = Object.freeze(["job", "paid_study", "mock_jury", "freelance", "lead", "other"]);
export const EXECUTION_CLASSES = Object.freeze(["AUTO", "APPROVAL_REQUIRED", "MANUAL"]);
export const STATUSES = Object.freeze(["discovered", "approved", "manual", "pursuing", "applied", "won", "lost", "skipped", "expired", "rejected"]);
/** What Atlas would do next. Only `read_only` can ever be AUTO. */
export const ACTION_KINDS = Object.freeze(["read_only", "apply", "contact", "task"]);

const DEFAULT_HOURS = 2;
const MIN_HOURS = 0.25;
const MAX_PAYOUT = 1_000_000;
const MAX_EVIDENCE = 3;
const MAX_QUOTE = 240;

/** Things only the owner can do: Atlas never works around them. */
const MANUAL_SIGNALS = [
  [/\b(?:re)?captcha\b|\bhcaptcha\b|\bi am not a robot\b/iu, "a CAPTCHA"],
  [/\bverify your identity\b|\bidentity verification\b|\bgovernment[- ]issued\b|\bpassport\b|\bdriver'?s licen[cs]e\b|\bphoto id\b|\bkyc\b/iu, "identity verification"],
  [/\bsocial security\b|\bssn\b|\btax id\b|\bbackground check\b/iu, "sensitive personal identifiers"],
  [/\bvideo (?:interview|call)\b|\bphone (?:interview|screen)\b|\blive (?:interview|session|focus group)\b|\bwebcam\b|\bzoom (?:interview|session)\b/iu, "a live interview or session"],
  [/\bnotari[sz]ed\b|\bunder penalty of perjury\b|\bi (?:hereby )?(?:certify|attest|swear)\b|\bsign (?:and|&) return\b|\be-?sign(?:ature)?\b/iu, "a personal attestation or signature"],
];

/** Signs of a scam: the opportunity is rejected, not ranked. */
const SCAM_SIGNALS = [
  [/(?<!\b(?:no|without|never|zero|free of)\s)(?:\b(?:registration|application|processing|training|starter kit|activation) fee\b|\bpay (?:a|the) fee\b|\bsmall (?:upfront )?fee\b|\bdeposit required\b)/iu, "asks you to pay to take part"],
  [/\bgift cards?\b|\bwire transfer\b|\bcashier'?s check\b|\bsend (?:us )?money\b|\bwestern union\b|\bmoneygram\b/iu, "involves gift cards, wires or cashier's checks"],
  [/\bguaranteed (?:income|earnings|profit)\b|\bget rich\b|\bno experience needed,? earn \$?\d{3,}/iu, "promises guaranteed earnings"],
  [/\bcrypto(?:currency)? (?:deposit|investment)\b|\bforex (?:signals|trading)\b|\bmlm\b|\bpyramid\b/iu, "looks like an investment or pyramid scheme"],
];

const ACCOUNT_SIGNAL = /\b(?:create|register for|sign up for) (?:an|your) account\b|\blog ?in to (?:apply|continue|view)\b|\bmembers? only\b/iu;

/** Strip what does not identify the page, so one listing found twice is one record. */
export function canonicalKey(candidate) {
  let url;
  try { url = new URL(candidate); } catch { return null; }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const host = url.hostname.toLowerCase().replace(/^www\./u, "");
  const keep = [...url.searchParams.entries()]
    .filter(([name]) => !/^(?:utm_.*|gclid|fbclid|mc_[a-z]+|ref|ref_src|source|campaign|trk|trackingid|igshid)$/iu.test(name))
    .sort(([a], [b]) => a.localeCompare(b));
  const query = keep.length ? `?${keep.map(([name, value]) => `${name}=${value}`).join("&")}` : "";
  const path = url.pathname.replace(/\/+$/u, "") || "";
  return `${host}${path}${query}`;
}

const collapse = (text) => String(text ?? "").replace(/\s+/gu, " ").trim();

/** Every number the page shows, so a pay figure can be checked against it. */
function numbersIn(text) {
  const found = new Set();
  for (const match of String(text).matchAll(/\d[\d,]*(?:\.\d+)?/gu)) {
    const value = Number(match[0].replaceAll(",", ""));
    if (Number.isFinite(value)) found.add(value);
  }
  return found;
}

function number(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(String(value).replace(/[$,\s]/gu, ""));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

const clamp01 = (value, fallback) => {
  const parsed = number(value);
  return parsed === null ? fallback : Math.min(1, Math.max(0, parsed));
};

/** A deadline as a date, or null when the model gave none or something that is not a date. */
function isoDate(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString().slice(0, 10) : null;
}

/**
 * Turn what a model said about one retrieved page into a record, or refuse.
 *
 * @param {object} raw     the model's JSON (untrusted)
 * @param {{ url: string, title?: string, text: string, sourceName?: string, now?: number }} page  what Atlas actually retrieved
 * @returns {{ ok: true, opportunity: object } | { ok: false, reason: string }}
 */
export function normalizeOpportunity(raw, page) {
  const now = page.now ?? Date.now();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, reason: "The page could not be read as an opportunity." };
  if (raw.isOpportunity === false) return { ok: false, reason: "The page is not an opportunity." };
  const key = canonicalKey(page.url);
  if (!key) return { ok: false, reason: "The page has no usable web address." };
  const address = new URL(page.url).toString();
  const text = collapse(page.text);
  const lowered = text.toLowerCase();

  // A quotation must really be on the page; at least one is required.
  const evidence = [];
  for (const quote of Array.isArray(raw.evidence) ? raw.evidence : []) {
    const cleaned = collapse(quote).slice(0, MAX_QUOTE);
    if (cleaned.length >= 12 && lowered.includes(cleaned.toLowerCase()) && !evidence.includes(cleaned)) evidence.push(cleaned);
    if (evidence.length === MAX_EVIDENCE) break;
  }
  if (!evidence.length) return { ok: false, reason: "Nothing the page says supports this opportunity." };

  const scam = SCAM_SIGNALS.filter(([pattern]) => pattern.test(text)).map(([, label]) => label);
  if (scam.length) return { ok: false, reason: `Looks like a scam: ${scam.join("; ")}.`, rejected: true, key };

  // Pay is kept only when the page itself shows the figure.
  const shown = numbersIn(text);
  let payoutMinUsd = number(raw.payoutMinUsd ?? raw.payoutUsd);
  let payoutMaxUsd = number(raw.payoutMaxUsd ?? raw.payoutUsd);
  const warnings = [];
  const supported = (value) => value !== null && value > 0 && value <= MAX_PAYOUT && shown.has(value);
  if (!supported(payoutMinUsd)) { if (payoutMinUsd !== null) warnings.push("Pay figure not found on the page; ignored."); payoutMinUsd = null; }
  if (!supported(payoutMaxUsd)) payoutMaxUsd = payoutMinUsd;
  if (payoutMinUsd !== null && payoutMaxUsd !== null && payoutMaxUsd < payoutMinUsd) payoutMaxUsd = payoutMinUsd;
  const payoutUnit = ["total", "hour"].includes(raw.payoutUnit) ? raw.payoutUnit : "total";

  const estimatedHours = number(raw.estimatedHours);
  const hours = estimatedHours !== null && estimatedHours > 0 && estimatedHours <= 400 ? estimatedHours : null;
  const kind = OPPORTUNITY_KINDS.includes(raw.kind) ? raw.kind : "other";
  const actionKind = ACTION_KINDS.includes(raw.nextAction?.kind) ? raw.nextAction.kind : "apply";
  const deadline = isoDate(raw.deadline);
  if (deadline && Date.parse(`${deadline}T23:59:59Z`) < now) return { ok: false, reason: `The deadline (${deadline}) has passed.` };
  const requirements = (Array.isArray(raw.requirements) ? raw.requirements : []).map((item) => collapse(item).slice(0, 200)).filter(Boolean).slice(0, 12);
  // Questions the application asks are listed so the owner answers them; Atlas never fills them in.
  const questions = (Array.isArray(raw.questions) ? raw.questions : []).map((item) => collapse(item).slice(0, 200)).filter(Boolean).slice(0, 20);

  const manual = new Set(MANUAL_SIGNALS.filter(([pattern]) => pattern.test(text)).map(([, label]) => label));
  for (const [flag, label] of [["captcha", "a CAPTCHA"], ["identityVerification", "identity verification"], ["liveSession", "a live interview or session"], ["attestation", "a personal attestation or signature"]]) {
    if (raw.flags?.[flag] === true) manual.add(label);
  }
  const needsAccount = raw.flags?.requiresAccount === true || ACCOUNT_SIGNAL.test(text);
  const injection = detectInjection(text);
  if (injection.length) warnings.push(`The page contains text shaped like instructions to an AI (${injection.join(", ")}); it was treated as data only.`);

  const title = collapse(raw.title || page.title || key).slice(0, 200);
  const opportunity = {
    key,
    url: address,
    title,
    kind,
    source: collapse(page.sourceName || new URL(address).hostname.replace(/^www\./u, "")).slice(0, 80),
    summary: collapse(raw.summary).slice(0, 500),
    payoutMinUsd, payoutMaxUsd, payoutUnit,
    estimatedHours: hours,
    hoursAssumed: hours === null,
    deadline,
    requirements,
    questions,
    evidence,
    nextAction: { kind: actionKind, description: collapse(raw.nextAction?.description).slice(0, 300) },
    flags: { manual: [...manual], needsAccount, personalData: raw.flags?.personalData !== false, injection: injection.length > 0 },
    fit: clamp01(raw.fit, 0.3),
    modelConfidence: clamp01(raw.confidence, 0.5),
    warnings,
  };
  opportunity.confidence = confidence(opportunity);
  const verdict = classify(opportunity);
  opportunity.executionClass = verdict.executionClass;
  opportunity.classReasons = verdict.reasons;
  opportunity.score = score(opportunity);
  opportunity.digest = digestOf(opportunity);
  return { ok: true, opportunity };
}

/** How complete and well-founded the record is: missing facts lower it, a model's own doubt lowers it. */
export function confidence(opportunity) {
  let value = opportunity.modelConfidence ?? 0.5;
  if (opportunity.estimatedHours === null) value *= 0.7;
  if (!opportunity.deadline) value *= 0.9;
  if (!opportunity.requirements.length) value *= 0.85;
  if (opportunity.flags.injection) value *= 0.5;
  return Math.round(Math.min(1, Math.max(0.02, value)) * 1000) / 1000;
}

/**
 * Class from the record's own facts. Order matters: the owner-only signals
 * win, then anything that sends data or commits the owner needs approval,
 * and only a read-only step with nothing personal is automatic.
 */
export function classify(opportunity) {
  const manual = opportunity.flags?.manual ?? [];
  if (manual.length) return { executionClass: "MANUAL", reasons: [`Needs you: ${manual.join(", ")}.`] };
  if (opportunity.flags?.needsAccount) return { executionClass: "MANUAL", reasons: ["Needs you: it requires an account or login Atlas does not have."] };
  const reasons = [];
  const action = opportunity.nextAction?.kind ?? "apply";
  if (action !== "read_only") reasons.push(action === "contact" ? "It would contact someone for you." : action === "task" ? "It would do work on a third-party site for you." : "It would submit an application for you.");
  if (opportunity.flags?.personalData !== false) reasons.push("It would use your personal information.");
  if (opportunity.flags?.injection) reasons.push("The page tried to instruct Atlas, so a person checks it.");
  if (reasons.length) return { executionClass: "APPROVAL_REQUIRED", reasons };
  return { executionClass: "AUTO", reasons: ["Read-only: Atlas can look into it without sending anything or using your information."] };
}

/**
 * Expected value per hour: pay × the chance of qualifying and winning ÷ the
 * time it takes. Pay is the low end of a range (the figure you can count on);
 * an hourly rate is already per hour. Null when the page states no pay.
 */
export function score(opportunity) {
  const pay = opportunity.payoutMinUsd;
  if (pay === null || pay === undefined) return null;
  const chance = (opportunity.fit ?? 0) * (opportunity.confidence ?? confidence(opportunity));
  if (opportunity.payoutUnit === "hour") return round2(pay * chance);
  const hours = Math.max(MIN_HOURS, opportunity.estimatedHours ?? DEFAULT_HOURS);
  return round2((pay * chance) / hours);
}

/** What the owner can count on from this one: pay × chance, before time. */
export function expectedPayout(opportunity) {
  const pay = opportunity.payoutMinUsd;
  if (pay === null || pay === undefined) return 0;
  if (opportunity.payoutUnit === "hour") return round2(pay * Math.max(MIN_HOURS, opportunity.estimatedHours ?? DEFAULT_HOURS) * (opportunity.fit ?? 0) * (opportunity.confidence ?? 0));
  return round2(pay * (opportunity.fit ?? 0) * (opportunity.confidence ?? 0));
}

const round2 = (value) => Math.round(value * 100) / 100;

/**
 * An approval covers exactly these facts. If a re-discovery changes the pay,
 * the deadline, the class or the next action, the digest changes and the old
 * approval no longer applies.
 */
export function digestOf(opportunity) {
  return createHash("sha256").update(JSON.stringify({
    key: opportunity.key, url: opportunity.url,
    pay: [opportunity.payoutMinUsd, opportunity.payoutMaxUsd, opportunity.payoutUnit],
    hours: opportunity.estimatedHours, deadline: opportunity.deadline,
    action: opportunity.nextAction, executionClass: opportunity.executionClass, questions: opportunity.questions,
  })).digest("hex");
}

/**
 * The goal in plain words: "Find legitimate opportunities for me to make $500
 * this week" → a target and a horizon. Both are optional; nothing is guessed
 * beyond what the words say.
 */
export function parseGoal(text) {
  const goal = collapse(text);
  const money = /\$\s?(\d[\d,]*(?:\.\d+)?)\s*(k)?\b/iu.exec(goal) ?? /\b(\d[\d,]*(?:\.\d+)?)\s*(k)?\s*(?:dollars|usd)\b/iu.exec(goal);
  let targetUsd = null;
  if (money) {
    targetUsd = Number(money[1].replaceAll(",", "")) * (money[2] ? 1000 : 1);
    if (!Number.isFinite(targetUsd) || targetUsd <= 0 || targetUsd > 10_000_000) targetUsd = null;
  }
  let horizonDays = null;
  const days = /\b(?:in|within|over|next)\s+(\d{1,3})\s+days?\b/iu.exec(goal);
  if (days) horizonDays = Number(days[1]);
  else if (/\b(?:today|tonight)\b/iu.test(goal)) horizonDays = 1;
  else if (/\b(?:this|next|per|a|each|every)\s+week\b|\bweekly\b|\bin a week\b/iu.test(goal)) horizonDays = 7;
  else if (/\b(?:this|next|per|a|each|every)\s+month\b|\bmonthly\b/iu.test(goal)) horizonDays = 30;
  return { goal, targetUsd, horizonDays };
}
