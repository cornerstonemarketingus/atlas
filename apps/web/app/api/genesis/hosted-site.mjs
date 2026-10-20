import { inferSpecification } from "../../../../local-control/src/platform/genesis/requirements.mjs";
import { siteConfig } from "../../../../local-control/src/platform/genesis/templates/site-config.mjs";
import { createRenderer, validateSite } from "../../../../local-control/src/platform/genesis/templates/static-site/files/scripts/render.mjs";
import { SITE_STYLES } from "./site-assets.mjs";

/**
 * Hosted website creation: Genesis's own specification, site configuration and
 * page renderer, run inside the Worker.
 *
 * Nothing here executes generated code. The renderer only builds escaped
 * strings, so the "isolated execution" is that no user or model text is ever
 * run. The durable source of a site is its `site.json`, stored on the project
 * row; every page is rendered from it on demand, so there are no files to lose.
 *
 * What is and is not verified is stated, never implied: structure and links are
 * checked here; a real browser pass (layout at phone and desktop widths) and
 * enquiry delivery are not run by the hosted path.
 */

export const HOSTED_KIND = "hosted-static-site";
export const HOSTED_SITE_DAILY_LIMIT = 20;
export const PREVIEW_ID = /^gen_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const MAX_TEXT = 4_000;
const MAX_SITE_BYTES = 200_000;
const FILE_NAME = /^[a-z0-9-]+\.(?:html|css|js)$/u;

export const previewBase = (id) => `/preview/${id}`;

/** Tells the person this is a preview, and why the enquiry form does not send. */
const PREVIEW_CSS = `
.atlas-preview-bar{position:sticky;top:0;z-index:50;padding:6px 12px;background:#111827;color:#f9fafb;font:600 13px/1.4 system-ui,sans-serif;text-align:center}
`;
const PREVIEW_CONTACT_JS = `const form = document.getElementById("enquiry");
const error = document.getElementById("enquiry-error");
form?.addEventListener("submit", (event) => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(form).entries());
  error.textContent = !String(data.name ?? "").trim() ? "Please tell us your name."
    : !/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/u.test(String(data.email ?? "").trim()) ? "Please enter a valid email address."
      : !String(data.message ?? "").trim() ? "Please tell us how we can help."
        : "This is a preview, so enquiries are not sent. They are collected once the site is published.";
  error.hidden = false;
});
`;

/** The most informative reading of the person's words: a website with a named business, a place and services scores highest. */
function readSpecification(candidates) {
  let best = null;
  for (const text of candidates) {
    const value = String(text ?? "").trim().slice(0, MAX_TEXT);
    if (!value) continue;
    let spec;
    try { spec = inferSpecification(value); } catch { continue; }
    const score = (spec.archetype === "website" ? 8 : 0) + (spec.business ? 2 : 0) + (spec.location ? 2 : 0) + (spec.services?.length ? 1 : 0);
    if (!best || score > best.score) best = { spec, score, text: value };
  }
  return best;
}

/**
 * @param {{ userMessage?: string, description?: string, template?: string }} input
 * @returns {{ ok: true, spec: object, site: object } | { ok: false, code: string, message: string }}
 */
export function planHostedSite({ userMessage = "", description = "", template = "" } = {}) {
  const read = readSpecification([userMessage, description]);
  if (!read) return { ok: false, code: "INVALID_PROJECT", message: "Describe the website to build." };
  if (read.spec.archetype !== "website" || (template && template !== "static-site")) {
    return { ok: false, code: "UNSUPPORTED_HOSTED_PROJECT", message: "Hosted creation builds business websites. Apps and APIs need a connected Genesis node." };
  }
  const site = siteConfig(read.spec);
  const problems = validateSite(site);
  if (problems.length) return { ok: false, code: "INVALID_PROJECT", message: `The site could not be built: ${problems.join("; ")}.` };
  if (JSON.stringify(site).length > MAX_SITE_BYTES) return { ok: false, code: "INVALID_PROJECT", message: "The site is too large for hosted creation." };
  return { ok: true, spec: read.spec, site };
}

function renderedFiles(site, id) {
  const renderer = createRenderer(site, { base: previewBase(id) });
  const files = new Map();
  for (const page of site.pages) files.set(renderer.fileFor(page), renderer.render(page));
  return { renderer, files };
}

/**
 * Structural verification of every rendered page. It does not open a browser:
 * `browserChecks` is always "not-run" so a report cannot overstate it.
 */
export function verifyHostedSite(site, id) {
  const base = previewBase(id);
  const { renderer, files } = renderedFiles(site, id);
  const checks = [];
  const check = (name, ok, detail = "") => checks.push({ name, ok: Boolean(ok), ...(detail && !ok ? { detail } : {}) });
  const known = new Set([...files.keys()].map((file) => (file === "index.html" ? base : `${base}/${file}`)).concat([`${base}/styles.css`, `${base}/contact.js`]));
  let placeholders = 0;
  for (const [file, html] of files) {
    check(`${file}: one non-empty h1`, (html.match(/<h1[\s>]/gu) ?? []).length === 1 && /<h1>[^<]+<\/h1>/u.test(html));
    check(`${file}: title`, /<title>[^<]+<\/title>/u.test(html));
    check(`${file}: description`, /<meta name="description" content="[^"]{1,160}">/u.test(html));
    check(`${file}: language and viewport`, /<html lang="en">/u.test(html) && /<meta name="viewport" content="width=device-width, initial-scale=1">/u.test(html));
    const links = [...html.matchAll(/(?:href|src)="([^"]*)"/gu)].map((match) => match[1]).filter((value) => value !== "#main" && !/^(?:tel|mailto):/u.test(value));
    const broken = links.filter((value) => !known.has(value));
    check(`${file}: every link and asset resolves`, broken.length === 0, broken.slice(0, 3).join(", "));
    check(`${file}: no external resources`, !links.some((value) => /^(?:[a-z]+:)?\/\//iu.test(value)));
    const scripts = [...html.matchAll(/<script\b([^>]*)>/gu)].map((match) => match[1]);
    check(`${file}: only known scripts`, scripts.every((attrs) => /type="application\/ld\+json"/u.test(attrs) || attrs === ` type="module" src="${base}/contact.js"`));
    placeholders += (html.match(/\[Add [^\]]+\]/gu) ?? []).length;
  }
  const home = files.get("index.html") ?? "";
  const data = /<script type="application\/ld\+json">(.*?)<\/script>/su.exec(home);
  let structured = false;
  try { structured = data ? JSON.parse(data[1]).name === site.name : false; } catch { structured = false; }
  check("home: structured data names the business", structured);
  const contactPages = site.pages.filter((page) => page.sections.some((section) => section.type === "contact"));
  check("an enquiry form is present when a contact page exists", contactPages.every((page) => files.get(renderer.fileFor(page))?.includes('id="enquiry"')));
  check("navigation lists every page", [...files.values()].every((html) => (html.match(/<nav aria-label="Main">(.*?)<\/nav>/su)?.[1].match(/<a /gu) ?? []).length === site.pages.length));
  check("sitemap lists every page", (renderer.sitemap().match(/<loc>/gu) ?? []).length === site.pages.length);
  return {
    ok: checks.every((item) => item.ok), pages: files.size, checks, ownerContentNeeded: placeholders,
    browserChecks: "not-run", enquiryDelivery: "preview-only",
  };
}

const PAGE_PATH = (page, renderer, id) => `${previewBase(id)}${renderer.fileFor(page) === "index.html" ? "" : `/${renderer.fileFor(page)}`}`;

/** The result the chat tool and the project card share. Fixed copy; no input is echoed back. */
export function hostedResult(row, site, verification) {
  const renderer = createRenderer(site, { base: previewBase(row.id) });
  return {
    status: "ready", hosted: true, operationId: row.id, projectId: row.id, projectState: "ready",
    name: row.name, visibility: "private", previewUrl: row.previewUrl, repository: null, commit: null, deploymentState: "not-deployed",
    pages: site.pages.map((page) => ({ title: page.title, path: PAGE_PATH(page, renderer, row.id) })),
    verification: { structure: verification.ok ? "passed" : "failed", checks: verification.checks.length, browserChecks: verification.browserChecks, ownerContentNeeded: verification.ownerContentNeeded, enquiryDelivery: verification.enquiryDelivery },
    message: `Built ${verification.pages} pages from the specification and checked structure and links (${verification.checks.length} checks passed). A preview is ready. No browser layout check ran, the enquiry form does not send in the preview, ${verification.ownerContentNeeded} placeholder${verification.ownerContentNeeded === 1 ? "" : "s"} still need real business facts, and nothing is published.`,
  };
}

const failure = (code, message) => ({ status: "failed", code, message });
const unavailable = (reason, nextStep) => ({ status: "unavailable", reason, nextStep, message: "Hosted website creation is unavailable. Nothing was created." });

/**
 * Create (or return the existing) hosted website for a request.
 * @param {{ insert: Function, get: Function, countSince: Function }} store
 * @param {{ tenantId: number, principal: string }} scope
 */
export async function createHostedSite({ store, scope, requestId, userMessage, input = {}, now = () => new Date(), reserve = async () => {} }) {
  const plan = planHostedSite({ userMessage, description: input.description, template: input.template });
  if (!plan.ok) return failure(plan.code, plan.message);
  const id = `gen_${/^[0-9a-f-]{36}$/u.test(String(requestId)) ? requestId : crypto.randomUUID()}`;
  try { await reserve(id); }
  catch { return unavailable("history_required", "Project creation requires saved conversation history. Reopen a saved chat and try again. No creation request was sent."); }
  try {
    const existing = await store.get(scope, id);
    if (existing) return resultFromRow(existing);
    const since = new Date(now().getTime() - 24 * 60 * 60 * 1000).toISOString();
    if ((await store.countSince(scope.tenantId, since)) >= HOSTED_SITE_DAILY_LIMIT) return failure("RATE_LIMITED", `Hosted creation is limited to ${HOSTED_SITE_DAILY_LIMIT} websites per day for this workspace. Try again tomorrow.`);
    const verification = verifyHostedSite(plan.site, id);
    if (!verification.ok) return failure("VERIFICATION_FAILED", `The site failed its own checks and was not saved: ${verification.checks.filter((item) => !item.ok).slice(0, 3).map((item) => item.name).join("; ")}.`);
    const stamp = now().toISOString();
    const row = {
      id, tenantId: scope.tenantId, requestedBy: scope.principal, prompt: String(userMessage || input.description || "").slice(0, MAX_TEXT), name: plan.site.name.slice(0, 120),
      requirementsJson: JSON.stringify({ kind: HOSTED_KIND, spec: plan.spec, site: plan.site }), status: "ready", repository: null, previewUrl: previewBase(id), deploymentUrl: null,
      evidenceJson: JSON.stringify([{ kind: "hosted-verification", capturedAt: stamp, ...verification }]), createdAt: stamp, updatedAt: stamp,
    };
    await store.insert(row);
    return hostedResult(row, plan.site, verification);
  } catch {
    return unavailable("storage_not_ready", "The project database could not be written. The owner must confirm D1 migration 0016_project_genesis is applied, then retry.");
  }
}

/** Rebuild the result from a stored row (status checks and repeated tool calls). */
export function resultFromRow(row) {
  const parsed = JSON.parse(row.requirementsJson);
  const evidence = JSON.parse(row.evidenceJson).find((item) => item.kind === "hosted-verification");
  return hostedResult(row, parsed.site, evidence ?? { ok: false, pages: parsed.site.pages.length, checks: [], ownerContentNeeded: 0, browserChecks: "not-run", enquiryDelivery: "preview-only" });
}

/** True for a row this module created (the table also holds node-built projects). */
export function isHostedRow(row) {
  try { return row?.status === "ready" && JSON.parse(row.requirementsJson).kind === HOSTED_KIND; } catch { return false; }
}

export const previewHeaders = (contentType) => ({
  "content-type": contentType, "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "x-robots-tag": "noindex, nofollow",
  "content-security-policy": "default-src 'none'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'",
});

/**
 * One file of a preview. The project id is an unguessable capability; the page
 * is noindex, sandboxed by CSP, and states that it is not published.
 * @returns {{ status: number, headers: Record<string,string>, body: string }}
 */
export function renderPreviewFile(row, file) {
  const missing = { status: 404, headers: previewHeaders("text/plain; charset=utf-8"), body: "Not found.\n" };
  if (!isHostedRow(row)) return missing;
  const name = file === "" ? "index.html" : file;
  if (!FILE_NAME.test(name)) return missing;
  const { site } = JSON.parse(row.requirementsJson);
  if (name === "styles.css") return { status: 200, headers: previewHeaders("text/css; charset=utf-8"), body: `${SITE_STYLES}\n${PREVIEW_CSS}` };
  if (name === "contact.js") return { status: 200, headers: previewHeaders("text/javascript; charset=utf-8"), body: PREVIEW_CONTACT_JS };
  const { files } = renderedFiles(site, row.id);
  const html = files.get(name);
  if (!html) return missing;
  const banner = '<div class="atlas-preview-bar" role="note">Atlas preview. This site is not published.</div>';
  // An inline empty icon stops the browser asking the app for /favicon.ico, whose 404 page the preview's CSP would rightly refuse to load fonts for.
  return { status: 200, headers: previewHeaders("text/html; charset=utf-8"), body: html.replace("<head>\n", '<head>\n<link rel="icon" href="data:,">\n').replace("<body>\n", `<body>\n${banner}\n`) };
}
