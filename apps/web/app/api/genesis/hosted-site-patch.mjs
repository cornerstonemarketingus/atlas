/**
 * The patch a person may apply to a hosted website from chat, and the one
 * validator that decides whether a model-written patch is acceptable.
 *
 * Dependency-free on purpose: it is the trust boundary, so it is small, pure and
 * testable on its own. The model's JSON never reaches the stored site except
 * through `validatePatch`, which returns a normalised copy built field by field.
 *
 * What it guarantees:
 *  - only the fields below; any other key, at any depth, is rejected;
 *  - no markup, URLs, scripts or domains in any text (visitors' links come only
 *    from a validated phone or email, which the renderer turns into tel:/mailto:);
 *  - control and invisible characters are stripped before any check;
 *  - hard length and count limits;
 *  - facts only the owner knows are never invented: a phone number, an email, a
 *    number (years, counts), and any credential, licence, insurance, award,
 *    review or testimonial sentence is accepted only when the person's own
 *    message in this turn contains it (and does not negate it).
 */

export const PATCH_LIMITS = Object.freeze({
  name: 80, tagline: 100, cta: 40, area: 80, paragraph: 1200, serviceTitle: 60, serviceText: 200,
  services: 8, pageText: 6, pages: 3,
});
/** Pages a person may add or remove from chat. Home and Contact are structural (the call-to-action links to Contact). */
export const EDITABLE_PAGES = Object.freeze(["services", "about", "gallery"]);
export const TEXT_SLOTS = Object.freeze(["story", "credentials", "details"]);
export const PROJECT_ID = /^gen_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

const ANY_CONTROL = /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202f\u205f-\u206f\u3164\ufeff\ufff9-\ufffb]/gu;
const TEXT_CHARS = /^[\p{L}\p{N}\p{M} .,;:!?'’"“”()&/%$#+*–—-]+$/u;
const NAME_CHARS = /^[\p{L}\p{N}\p{M} .,'’&()/-]+$/u;
const URL_LIKE = /(?:^|[^\p{L}])(?:https?|ftp|javascript|data|vbscript|file|mailto|tel|sms):|\/\/|\bwww\.|[\p{L}\p{N}-]\.(?:com|net|org|io|co|us|biz|info|app|dev|site|xyz|me|ca|uk|online|store|shop|ly|gl|edu|gov)\b|\b\d{1,3}(?:\.\d{1,3}){3}\b/iu;
const CLAIM_WORDS = /\b(?:licen[sc]\w*|insur\w*|bond(?:ed|ing)|certif\w*|accredit\w*|warrant\w*|guarant\w*|award\w*|testimonial\w*|review\w*|rated|rating|stars?|years?|since|established|founded|family[- ]owned|osha|epa|bbb|better business|members? of|affiliat\w*|trusted by|number one|best|top[- ]rated|satisf\w*|fully|workmanship|references?)\b|["“”]|#\s?1\b/iu;
const NEGATION = /(?:\b(?:not|no|never|without|yet|cannot|lack\w*|neither|nor)\b|\bn t\b)[^.]{0,40}$/u;

export const normaliseForMatch = (value) => String(value ?? "").toLowerCase().normalize("NFKC").replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/** Strip control and invisible characters, fold whitespace, normalise to NFC. */
export function cleanText(value) {
  return String(value).replace(/[\t\n\r]+/gu, " ").replace(ANY_CONTROL, "").normalize("NFC").replace(/ {2,}/gu, " ").trim();
}

/** True when `sentence` appears in the person's message and the occurrence is not negated ("not licensed"). */
function stated(sentence, message) {
  const needle = normaliseForMatch(sentence);
  if (!needle) return true;
  let from = 0;
  for (;;) {
    const at = message.indexOf(needle, from);
    if (at === -1) return false;
    const edge = (at === 0 || message[at - 1] === " ") && (at + needle.length === message.length || message[at + needle.length] === " ");
    if (edge && !NEGATION.test(message.slice(Math.max(0, at - 45), at))) return true;
    from = at + 1;
  }
}

/**
 * The anti-invention guard. Returns null when `text` is supported by the person's
 * message, otherwise the reason. Numbers must be in the message; every sentence
 * that makes a claim (licence, insurance, award, review, years, quote…) must be
 * the person's own words.
 */
export function unsupportedClaim(text, userMessage, { allClaims = false } = {}) {
  const message = normaliseForMatch(userMessage);
  for (const number of text.match(/\p{N}+/gu) ?? []) {
    if (!new RegExp(`(?:^| )${number}(?: |$)`, "u").test(message) && !userMessage.includes(number)) return `the number ${number} is not in the person's message`;
  }
  for (const sentence of text.split(/(?<=[.!?;])\s+/u)) {
    if (!allClaims && !CLAIM_WORDS.test(sentence)) continue;
    if (!stated(sentence, message)) return `"${sentence.slice(0, 60)}" is a claim the person did not state in their own message`;
  }
  return null;
}

const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));

/**
 * @param {unknown} input  the model's tool arguments
 * @param {{ userMessage?: string }} context
 * @returns {{ ok: true, patch: object } | { ok: false, errors: { path: string, code: string, message: string }[] }}
 */
export function validatePatch(input, { userMessage = "" } = {}) {
  const errors = [];
  const fail = (path, code, message) => { errors.push({ path, code, message }); return undefined; };
  const message = String(userMessage ?? "");

  const object = (value, path, allowed) => {
    if (!isPlainObject(value)) return fail(path, "type", "must be an object");
    /* guard:unknown-fields */
    for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(`${path}.${key}`, "unknown_field", "is not an editable field");
    return value;
  };
  const text = (value, path, { min = 1, max, chars = TEXT_CHARS, claims = true, allClaims = false }) => {
    if (typeof value !== "string") return fail(path, "type", "must be a string");
    /* guard:length */
    if (value.length > max * 4) return fail(path, "too_long", `must be at most ${max} characters`);
    /* guard:strip */
    const clean = cleanText(value);
    if (clean.length < min) return fail(path, "too_short", `must be at least ${min} characters`);
    if (clean.length > max) return fail(path, "too_long", `must be at most ${max} characters`);
    /* guard:charset */
    if (!chars.test(clean)) return fail(path, "characters", "contains characters that are not allowed (no markup, brackets or symbols)");
    /* guard:urls */
    if (URL_LIKE.test(clean)) return fail(path, "url", "must not contain links or web addresses");
    /* guard:claims */
    if (claims) { const reason = unsupportedClaim(clean, message, { allClaims }); if (reason) return fail(path, "unsupported_claim", `${reason}. Ask the person to say it in their own words, then use exactly that.`); }
    return clean;
  };

  const root = object(input, "patch", ["projectId", "basedOn", "businessName", "tagline", "ctaText", "contact", "pageText", "addServices", "removeServices", "addPages", "removePages"]);
  if (!root) return { ok: false, errors };
  const patch = {};

  if (typeof root.projectId !== "string" || !PROJECT_ID.test(root.projectId)) fail("patch.projectId", "project_id", "must be the project id from the create result");
  else patch.projectId = root.projectId;
  if (root.basedOn !== undefined) {
    if (typeof root.basedOn !== "string" || !/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/u.test(root.basedOn)) fail("patch.basedOn", "type", "must be the updatedAt value from the last result");
    else patch.basedOn = root.basedOn;
  }
  if (root.businessName !== undefined) { const value = text(root.businessName, "patch.businessName", { min: 2, max: PATCH_LIMITS.name, chars: NAME_CHARS }); if (value !== undefined) patch.businessName = value; }
  if (root.tagline !== undefined) { const value = text(root.tagline, "patch.tagline", { max: PATCH_LIMITS.tagline }); if (value !== undefined) patch.tagline = value; }
  if (root.ctaText !== undefined) { const value = text(root.ctaText, "patch.ctaText", { min: 2, max: PATCH_LIMITS.cta }); if (value !== undefined) patch.ctaText = value; }

  if (root.contact !== undefined) {
    const contact = object(root.contact, "patch.contact", ["phone", "email", "area"]);
    if (contact) {
      patch.contact = {};
      for (const key of ["phone", "email", "area"]) {
        const value = contact[key];
        if (value === undefined) continue;
        if (value === null) { patch.contact[key] = null; continue; }
        const path = `patch.contact.${key}`;
        if (key === "area") { const area = text(value, path, { max: PATCH_LIMITS.area }); if (area !== undefined) patch.contact.area = area; continue; }
        if (typeof value !== "string") { fail(path, "type", "must be a string or null"); continue; }
        const clean = cleanText(value);
        if (key === "phone") {
          const digits = clean.replace(/\D+/gu, "");
          /* guard:phone-format */
          if (!/^\+?[0-9 ().-]{7,24}$/u.test(clean) || digits.length < 7 || digits.length > 15 || (clean.match(/\(/gu) ?? []).length !== (clean.match(/\)/gu) ?? []).length) { fail(path, "phone", "is not a valid phone number"); continue; }
          /* guard:phone-grounding */
          if (!message.replace(/\D+/gu, "").includes(digits)) { fail(path, "unsupported_contact", "is not a number the person gave in their message. Never invent contact details; ask for it."); continue; }
          patch.contact.phone = clean;
        } else {
          /* guard:email-format */
          if (clean.length > 120 || clean.includes("..") || !/^[A-Za-z0-9._%+-]{1,64}@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,24}$/u.test(clean)) { fail(path, "email", "is not a valid email address"); continue; }
          /* guard:email-grounding */
          if (!message.toLowerCase().includes(clean.toLowerCase())) { fail(path, "unsupported_contact", "is not an address the person gave in their message. Never invent contact details; ask for it."); continue; }
          patch.contact.email = clean;
        }
      }
    }
  }

  if (root.pageText !== undefined) {
    if (!Array.isArray(root.pageText) || root.pageText.length > PATCH_LIMITS.pageText) fail("patch.pageText", "type", `must be a list of at most ${PATCH_LIMITS.pageText} edits`);
    else {
      patch.pageText = [];
      root.pageText.forEach((entry, index) => {
        const path = `patch.pageText[${index}]`;
        const item = object(entry, path, ["slot", "page", "text"]);
        if (!item) return;
        if (!TEXT_SLOTS.includes(item.slot)) return void fail(`${path}.slot`, "enum", `must be one of ${TEXT_SLOTS.join(", ")}`);
        if (item.slot === "details" ? typeof item.page !== "string" || !/^[a-z0-9-]{1,40}$/u.test(item.page) : item.page !== undefined) return void fail(`${path}.page`, "page", item.slot === "details" ? "is required for details: the page id" : "is only used with the details slot");
        /* credentials, story and details are all claim-checked; credentials is always a claim. */
        const value = text(item.text, `${path}.text`, { min: 2, max: PATCH_LIMITS.paragraph, allClaims: item.slot === "credentials" });
        if (value !== undefined) patch.pageText.push({ slot: item.slot, ...(item.page ? { page: item.page } : {}), text: value });
      });
    }
  }

  if (root.addServices !== undefined) {
    if (!Array.isArray(root.addServices) || root.addServices.length > PATCH_LIMITS.services) fail("patch.addServices", "type", `must be a list of at most ${PATCH_LIMITS.services} services`);
    else {
      patch.addServices = [];
      root.addServices.forEach((entry, index) => {
        const path = `patch.addServices[${index}]`;
        const item = object(entry, path, ["title", "description"]);
        if (!item) return;
        const title = text(item.title, `${path}.title`, { max: PATCH_LIMITS.serviceTitle });
        const description = item.description === undefined ? undefined : text(item.description, `${path}.description`, { max: PATCH_LIMITS.serviceText });
        if (title !== undefined && (item.description === undefined || description !== undefined)) patch.addServices.push({ title, text: description ?? `${title}.` });
      });
    }
  }
  if (root.removeServices !== undefined) {
    if (!Array.isArray(root.removeServices) || root.removeServices.length > PATCH_LIMITS.services) fail("patch.removeServices", "type", `must be a list of at most ${PATCH_LIMITS.services} service names`);
    else patch.removeServices = root.removeServices.map((title, index) => text(title, `patch.removeServices[${index}]`, { max: PATCH_LIMITS.serviceTitle, claims: false })).filter((title) => title !== undefined);
  }
  for (const key of ["addPages", "removePages"]) {
    if (root[key] === undefined) continue;
    /* guard:page-set */
    if (!Array.isArray(root[key]) || root[key].length > PATCH_LIMITS.pages || !root[key].every((page) => EDITABLE_PAGES.includes(page)) || new Set(root[key]).size !== root[key].length) fail(`patch.${key}`, "enum", `must be a list of unique pages from ${EDITABLE_PAGES.join(", ")}`);
    else patch[key] = [...root[key]];
  }
  if (patch.addPages?.some((page) => patch.removePages?.includes(page))) fail("patch.addPages", "conflict", "a page cannot be added and removed in one edit");

  if (errors.length === 0 && !["businessName", "tagline", "ctaText", "contact", "pageText", "addServices", "removeServices", "addPages", "removePages"].some((key) => patch[key] !== undefined && (!Array.isArray(patch[key]) || patch[key].length > 0) && !(key === "contact" && Object.keys(patch.contact).length === 0))) fail("patch", "empty", "contains no edit");
  return errors.length ? { ok: false, errors } : { ok: true, patch };
}

/** The tool definition. The schema mirrors the validator for the model's benefit; the validator is what enforces. */
export const UPDATE_PROJECT_TOOL = { type: "function", function: {
  name: "workspace_update_project",
  description: "Edit a hosted website that workspace_create_project built, using facts the person gave in THEIR OWN MESSAGE: phone, email, service area, business name, tagline, button text, the about story, credentials the person actually holds, services to add or remove, pages to add or remove. Text is plain, no HTML or links. Never invent a phone, email, number, licence, insurance, award, review or testimonial: those are rejected unless the person's message contains them verbatim, so quote their words. The change is checked again and saved only if the checks pass; the preview link does not change.",
  parameters: { type: "object", additionalProperties: false, required: ["projectId"], properties: {
    projectId: { type: "string", description: "The project id (gen_...) from the create result." },
    basedOn: { type: "string", description: "Optional: the updatedAt from the last result; the edit is refused if the site changed since." },
    businessName: { type: "string", maxLength: PATCH_LIMITS.name },
    tagline: { type: "string", maxLength: PATCH_LIMITS.tagline },
    ctaText: { type: "string", maxLength: PATCH_LIMITS.cta, description: "Text of the main call-to-action button." },
    contact: { type: "object", additionalProperties: false, properties: {
      phone: { type: ["string", "null"], maxLength: 24, description: "A phone number the person stated; null removes it." },
      email: { type: ["string", "null"], maxLength: 120, description: "An email the person stated; null removes it." },
      area: { type: ["string", "null"], maxLength: PATCH_LIMITS.area, description: "Service area wording; null removes it." },
    } },
    pageText: { type: "array", maxItems: PATCH_LIMITS.pageText, items: { type: "object", additionalProperties: false, required: ["slot", "text"], properties: {
      slot: { type: "string", enum: [...TEXT_SLOTS], description: "story: the About company story. credentials: licensing/insurance/credentials, only the person's own words. details: the Details paragraph of a named page (also give page)." },
      page: { type: "string", description: "Page id, only for slot details." },
      text: { type: "string", maxLength: PATCH_LIMITS.paragraph },
    } } },
    addServices: { type: "array", maxItems: PATCH_LIMITS.services, items: { type: "object", additionalProperties: false, required: ["title"], properties: { title: { type: "string", maxLength: PATCH_LIMITS.serviceTitle }, description: { type: "string", maxLength: PATCH_LIMITS.serviceText } } } },
    removeServices: { type: "array", maxItems: PATCH_LIMITS.services, items: { type: "string", maxLength: PATCH_LIMITS.serviceTitle } },
    addPages: { type: "array", maxItems: PATCH_LIMITS.pages, items: { type: "string", enum: [...EDITABLE_PAGES] } },
    removePages: { type: "array", maxItems: PATCH_LIMITS.pages, items: { type: "string", enum: [...EDITABLE_PAGES] } },
  } },
} };
