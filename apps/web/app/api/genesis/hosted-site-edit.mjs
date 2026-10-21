import { siteConfig } from "../../../../local-control/src/platform/genesis/templates/site-config.mjs";
import { validateSite } from "../../../../local-control/src/platform/genesis/templates/static-site/files/scripts/render.mjs";
import { MAX_SITE_BYTES, hostedResult, isHostedRow, verifyHostedSite } from "./hosted-site.mjs";
import { normaliseForMatch, validatePatch } from "./hosted-site-patch.mjs";

/**
 * Edit a hosted website from chat: validate the patch, apply it to the stored
 * site.json, re-run the same structural verification as creation, and save only
 * if it passes. The preview URL (the project id) never changes.
 *
 * Concurrency: the row is read, the patch applied in memory, and written with
 * `WHERE updated_at = <the value read>`, so two edits cannot silently overwrite
 * each other; the loser is told to retry against the new state.
 */

const RANK = ["home", "services", "about", "gallery", "contact"];
const MAX_SERVICES = 12;
const MAX_EVIDENCE = 20;

const failure = (code, message, extra = {}) => ({ status: "failed", code, message, ...extra });
const lowerFirst = (value) => value.replace(/^./u, (c) => c.toLowerCase());
const upperFirst = (value) => value.replace(/^./u, (c) => c.toUpperCase());
const pageOf = (site, id) => site.pages.find((page) => page.id === id);
const sectionOf = (page, type) => page?.sections?.find((section) => section.type === type);
const placeOf = (site) => (site.location ? [site.location.city, site.location.region].filter(Boolean).join(", ") : "");

/** The site's service list, read back from the cards and gallery the template wrote. */
function servicesOf(site) {
  const out = []; const seen = new Set();
  const add = (title, text) => { const key = normaliseForMatch(title); if (key && !seen.has(key)) { seen.add(key); out.push({ title, text }); } };
  for (const item of sectionOf(pageOf(site, "services"), "cards")?.items ?? []) add(item.title, item.text);
  for (const item of sectionOf(pageOf(site, "home"), "cards")?.items ?? []) add(item.title, item.text);
  for (const title of sectionOf(pageOf(site, "gallery"), "gallery")?.items ?? []) add(title, `${title}.`);
  return out;
}

/** The sentences the template derives from the service list; replaced only while they are still exactly what the template wrote. */
const derived = (site, services) => {
  const place = placeOf(site);
  const titles = services.map((service) => service.title);
  return {
    tagline: `${titles.slice(0, 3).join(", ")}${place ? ` in ${place}` : ""}`,
    intro: `${upperFirst(titles.map(lowerFirst).join(", "))}${place ? ` for projects in ${place} and nearby` : ""}.`,
    description: `${site.name}${place ? `, ${place}` : ""}: ${titles.map((title) => title.toLowerCase()).join(", ")}.`.slice(0, 160),
  };
};

function writeServices(site, services) {
  const before = derived(site, servicesOf(site)); const after = derived(site, services);
  const home = pageOf(site, "home");
  const homeCards = sectionOf(home, "cards"); if (homeCards) homeCards.items = services.slice(0, 4).map((item) => ({ ...item }));
  const listing = sectionOf(pageOf(site, "services"), "cards"); if (listing) listing.items = services.map((item) => ({ ...item }));
  const gallery = sectionOf(pageOf(site, "gallery"), "gallery"); if (gallery) gallery.items = services.map((item) => item.title);
  if (site.tagline === before.tagline) site.tagline = after.tagline;
  if (home?.intro === before.intro) home.intro = after.intro;
  if (home?.description === before.description) home.description = after.description;
}

function renameIn(value, from, to) {
  if (typeof value === "string") return value.split(from).join(to);
  if (Array.isArray(value)) return value.map((item) => renameIn(item, from, to));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, key === "id" || key === "type" ? item : renameIn(item, from, to)]));
  return value;
}

/**
 * Apply a validated patch. Pure: returns a new site and spec, or why it cannot be applied.
 * @returns {{ ok: true, site: object, spec: object, changes: {field: string, summary: string}[], notes: string[] } | { ok: false, message: string }}
 */
export function applyPatch(siteIn, specIn, patch) {
  const site = structuredClone(siteIn); const spec = structuredClone(specIn ?? {});
  const changes = []; const notes = [];
  const note = (field, summary) => changes.push({ field, summary });

  if (patch.addServices?.length || patch.removeServices?.length) {
    let services = servicesOf(site);
    if (services.length === 0 && !patch.addServices?.length) return { ok: false, message: "This site has no services list to edit." };
    for (const title of patch.removeServices ?? []) {
      const key = normaliseForMatch(title);
      const found = services.find((service) => normaliseForMatch(service.title) === key);
      if (!found) return { ok: false, message: `There is no service called "${title}". Current services: ${services.map((service) => service.title).join(", ")}.` };
      services = services.filter((service) => service !== found);
      note("services", `Removed service "${found.title}"`);
      const custom = site.pages.find((page) => !RANK.includes(page.id) && normaliseForMatch(page.title) === key);
      if (custom) notes.push(`The page "${custom.title}" still exists; only Services, About and Gallery can be removed from chat.`);
    }
    for (const item of patch.addServices ?? []) {
      if (services.some((service) => normaliseForMatch(service.title) === normaliseForMatch(item.title))) return { ok: false, message: `The service "${item.title}" already exists.` };
      services = [...services, { title: item.title, text: item.text }];
      note("services", `Added service "${item.title}"`);
    }
    if (services.length === 0) return { ok: false, message: "A site needs at least one service." };
    if (services.length > MAX_SERVICES) return { ok: false, message: `A site can list at most ${MAX_SERVICES} services.` };
    writeServices(site, services);
  }

  if (patch.businessName !== undefined && patch.businessName !== site.name) {
    const from = site.name;
    site.pages = renameIn(site.pages, from, patch.businessName);
    site.tagline = renameIn(site.tagline, from, patch.businessName);
    for (const page of site.pages) page.description = String(page.description).slice(0, 160);
    site.name = patch.businessName; spec.name = patch.businessName;
    note("businessName", `Renamed the business to "${patch.businessName}"`);
  }

  for (const id of patch.addPages ?? []) {
    if (pageOf(site, id)) return { ok: false, message: `The ${id} page already exists.` };
    const template = siteConfig({ ...spec, name: site.name, pages: [{ id, title: upperFirst(id), purpose: "" }] }).pages.find((page) => page.id === id);
    if (!template) return { ok: false, message: `The ${id} page could not be built.` };
    const services = servicesOf(site);
    if (id === "services" && sectionOf(template, "cards")) sectionOf(template, "cards").items = services.map((item) => ({ ...item }));
    if (id === "gallery" && sectionOf(template, "gallery")) sectionOf(template, "gallery").items = services.map((item) => item.title);
    const later = site.pages.findIndex((page) => RANK.indexOf(page.id) > RANK.indexOf(id));
    site.pages.splice(later === -1 ? site.pages.length : later, 0, template);
    spec.pages = Array.isArray(spec.pages) ? [...spec.pages.filter((page) => page.id !== id), { id, title: template.title, purpose: template.intro }] : spec.pages;
    note("pages", `Added the ${template.title} page`);
  }

  for (const edit of patch.pageText ?? []) {
    const id = edit.slot === "details" ? edit.page : "about";
    const page = pageOf(site, id);
    if (!page) return { ok: false, message: `The ${id} page does not exist${id === "about" ? "; add it first with addPages" : ""}.` };
    const block = edit.slot === "details" ? page.sections.find((section) => section.type === "text" && section.title === "Details") : sectionOf(page, "text");
    if (!block) return { ok: false, message: `The ${id} page has no ${edit.slot === "details" ? "Details" : "text"} section to edit.` };
    block.paragraphs = Array.isArray(block.paragraphs) ? [...block.paragraphs] : [];
    const index = edit.slot === "credentials" ? 1 : 0;
    while (block.paragraphs.length < index) block.paragraphs.push("");
    block.paragraphs[index] = edit.text;
    note(`pageText.${edit.slot}`, `Replaced the ${edit.slot === "credentials" ? "credentials" : edit.slot === "story" ? "company story" : `${page.title} details`} text on the ${page.title} page`);
  }

  if (patch.tagline !== undefined && patch.tagline !== site.tagline) { site.tagline = patch.tagline; note("tagline", `Tagline set to "${patch.tagline}"`); }
  if (patch.ctaText !== undefined && patch.ctaText !== site.cta) { site.cta = patch.ctaText; note("ctaText", `Button text set to "${patch.ctaText}"`); }
  if (patch.contact) {
    site.contact = { phone: "", email: "", area: "", ...site.contact };
    for (const [key, value] of Object.entries(patch.contact)) {
      const next = value ?? "";
      if (next === site.contact[key]) continue;
      site.contact[key] = next;
      note(`contact.${key}`, value === null ? `Removed the ${key}` : `${upperFirst(key)} set to ${value}`);
    }
  }

  for (const id of patch.removePages ?? []) {
    if (!pageOf(site, id)) return { ok: false, message: `The ${id} page does not exist.` };
    site.pages = site.pages.filter((page) => page.id !== id);
    if (Array.isArray(spec.pages)) spec.pages = spec.pages.filter((page) => page.id !== id);
    note("pages", `Removed the ${id} page`);
  }
  if (changes.length === 0) return { ok: false, message: "Nothing would change: the site already says that." };
  return { ok: true, site, spec, changes, notes };
}

/**
 * Validate, apply, verify and save one edit.
 * @param {{ store: { get: Function, update: Function }, scope: { tenantId: number, principal: string }, userMessage?: string, input: unknown, now?: () => Date }} options
 */
export async function updateHostedSite({ store, scope, userMessage = "", input, now = () => new Date() }) {
  const checked = validatePatch(input, { userMessage });
  if (!checked.ok) return failure("INVALID_PATCH", `The edit was rejected and nothing was saved: ${checked.errors.slice(0, 5).map((error) => `${error.path} ${error.message}`).join("; ")}.`, { errors: checked.errors.slice(0, 10) });
  const { patch } = checked;
  let row;
  try { row = await store.get(scope, patch.projectId); } catch { return { status: "unavailable", reason: "storage_not_ready", message: "The project could not be read. Nothing was changed." }; }
  if (!row || !isHostedRow(row)) return { status: "not-found", message: "No hosted website with that id in this workspace. Nothing was changed." };
  const stale = () => failure("CONFLICT", "The site changed since it was last read, so nothing was saved. Read the project status, then apply the edit again.", { updatedAt: row.updatedAt });
  if (patch.basedOn && patch.basedOn !== row.updatedAt) return stale();

  const stored = JSON.parse(row.requirementsJson);
  const applied = applyPatch(stored.site, stored.spec, patch);
  if (!applied.ok) return failure("CANNOT_APPLY", `${applied.message} Nothing was saved.`);
  const problems = validateSite(applied.site);
  if (problems.length) return failure("INVALID_SITE", `The edit would break the site (${problems.join("; ")}), so nothing was saved.`);
  if (JSON.stringify(applied.site).length > MAX_SITE_BYTES) return failure("INVALID_SITE", "The edit would make the site too large. Nothing was saved.");
  const verification = verifyHostedSite(applied.site, row.id);
  if (!verification.ok) return failure("VERIFICATION_FAILED", `The edited site failed its own checks and was not saved: ${verification.checks.filter((item) => !item.ok).slice(0, 3).map((item) => item.name).join("; ")}.`);

  // Strictly later than what was read, so the guard can tell two edits apart even within one millisecond.
  const previous = Date.parse(row.updatedAt);
  const stamp = new Date(Math.max(now().getTime(), (Number.isFinite(previous) ? previous : 0) + 1)).toISOString();
  const evidence = [...JSON.parse(row.evidenceJson), { kind: "hosted-verification", capturedAt: stamp, edit: { changes: applied.changes.map((change) => change.field) }, ...verification }];
  const next = { ...row, name: applied.site.name.slice(0, 120), requirementsJson: JSON.stringify({ ...stored, spec: applied.spec, site: applied.site }), evidenceJson: JSON.stringify(evidence.length > MAX_EVIDENCE ? [evidence[0], ...evidence.slice(-(MAX_EVIDENCE - 1))] : evidence), updatedAt: stamp };
  let saved;
  try { saved = await store.update(scope, { id: row.id, expectedUpdatedAt: row.updatedAt, name: next.name, requirementsJson: next.requirementsJson, evidenceJson: next.evidenceJson, updatedAt: stamp }); } catch { return { status: "unavailable", reason: "storage_not_ready", message: "The edit could not be saved. Nothing was changed." }; }
  if (!saved) return stale();

  const count = verification.ownerContentNeeded;
  return {
    ...hostedResult(next, applied.site, verification),
    edited: true, updatedAt: stamp, changes: applied.changes, ...(applied.notes.length ? { notes: applied.notes } : {}), remainingPlaceholders: count,
    message: `Saved ${applied.changes.length} change${applied.changes.length === 1 ? "" : "s"}: ${applied.changes.map((change) => change.summary).join("; ")}. Checked structure and links again (${verification.checks.length} checks passed). The preview link is unchanged. No browser layout check ran, the enquiry form does not send in the preview, ${count} placeholder${count === 1 ? "" : "s"} still need real business facts, and nothing is published.`,
  };
}

