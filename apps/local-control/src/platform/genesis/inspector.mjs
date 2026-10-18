import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * Looks at a running Genesis application the way a person would, and reports
 * findings as evidence the repair loop can act on:
 *
 *   { check, page, expected, observed, severity }
 *
 * With a browser (Playwright from apps/browser-worker, the same engine Atlas's
 * browser tools use): every page at desktop (1280px) and phone (375px)
 * widths, console errors and uncaught exceptions, the expected heading,
 * horizontal overflow, navigation, and the critical workflows driven through
 * the real UI (add a record and find it by search; book an appointment; send
 * an enquiry). Screenshots are saved outside the project folder for a vision
 * model to review later.
 *
 * Without a browser it falls back to HTTP checks and says so (`limited:
 * true`): pages and assets load, the API round-trips a record. APIs have no
 * interface, so for them the HTTP checks are the whole inspection.
 *
 * Records created by a check are named "Atlas check …" and deleted afterwards.
 */

const here = dirname(fileURLToPath(import.meta.url));
const atlasRoot = resolve(here, "..", "..", "..", "..", "..");

export async function loadPlaywright() {
  const candidates = [
    () => import("playwright-core"),
    () => import(pathToFileURL(createRequire(join(atlasRoot, "apps", "browser-worker", "package.json")).resolve("playwright-core")).href),
  ];
  for (const load of candidates) {
    try {
      const module = await load();
      // The CommonJS build arrives as { default: { chromium, … } } when imported by path.
      return module?.chromium ? module : module?.default?.chromium ? module.default : null;
    } catch { /* next */ }
  }
  return null;
}

const finding = (check, page, expected, observed, severity = "error") => ({ check, page, expected, observed: String(observed).slice(0, 500), severity });

function sampleValue(field, marker) {
  if (field.type === "email") return `atlas.check.${marker}@example.com`;
  if (field.type === "tel") return "555-0100";
  if (field.type === "number") return "42";
  if (field.type === "date") return "2030-06-15";
  if (field.type === "time") return "10:30";
  if (field.type === "select") return field.options?.[0] ?? "";
  return field.key === "name" || field.key === "title" ? `Atlas check ${marker}` : `Checked by Atlas ${marker}`;
}

function projectConfig(project) {
  const file = project.plan.template === "static-site" ? "site.json" : "app.config.json";
  return JSON.parse(readFileSync(join(project.workspace, file), "utf8"));
}

async function api(base, path, options = {}) {
  const response = await fetch(`${base}${path}`, { ...options, headers: { "content-type": "application/json", ...(options.headers ?? {}) }, signal: AbortSignal.timeout(10_000) });
  const text = await response.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: response.status, body, headers: response.headers };
}

/**
 * Sign-in for an app with `auth.required`. First proves a signed-out caller
 * is refused, then, while sign-up is still open (no owner yet), signs up a
 * temporary inspector account that `end()` deletes again, so the owner's
 * first sign-up is unaffected. Once an owner exists Atlas does not know a
 * password, so signed-in workflow checks are skipped and say so.
 */
async function inspectorSession(base, config, note, findings) {
  if (!config.auth?.required) return { headers: {}, cookie: null, signedIn: true, end: async () => {} };
  const privateEntity = config.entities.find((entity) => !config.booking || entity.slug !== config.booking.entity);
  if (privateEntity) {
    const refused = await api(base, `/api/${privateEntity.slug}`).catch(() => ({ status: 0 }));
    note("signed out: private data is refused", refused.status === 401);
    if (refused.status !== 401) findings.push(finding("auth-required", `/api/${privateEntity.slug}`, "401 when signed out", `status ${refused.status}`));
  }
  const status = await api(base, "/api/auth/me").catch(() => ({ status: 0, body: {} }));
  if (!status.body?.signupOpen) {
    note("signed-in workflows skipped: the owner account exists and Atlas does not know its password", true);
    return { headers: {}, cookie: null, signedIn: false, end: async () => {} };
  }
  const credentials = { email: `atlas-inspector-${randomBytes(6).toString("hex")}@example.invalid`, password: randomBytes(18).toString("base64url") };
  const signup = await api(base, "/api/auth/signup", { method: "POST", body: JSON.stringify(credentials) });
  const cookie = signup.headers?.get("set-cookie")?.split(";")[0] ?? null;
  note("sign up and sign in", signup.status === 201 && Boolean(cookie));
  if (signup.status !== 201 || !cookie) {
    findings.push(finding("auth-signup", "/api/auth/signup", "201 with a session cookie", `${signup.status} ${JSON.stringify(signup.body).slice(0, 200)}`));
    return { headers: {}, cookie: null, signedIn: false, end: async () => {} };
  }
  const headers = { cookie };
  return {
    headers, cookie, credentials, signedIn: true,
    async end() {
      const removed = await api(base, "/api/auth/me", { method: "DELETE", headers }).catch(() => ({ status: 0 }));
      note("temporary inspector account removed", removed.status === 200);
      if (removed.status !== 200) findings.push(finding("auth-cleanup", "/api/auth/me", "the inspector account is deleted", `status ${removed.status}`));
    },
  };
}

/** HTTP-level inspection: complete for APIs, a limited fallback for interfaces. */
export async function inspectOverHttp(project, preview) {
  const base = preview.url;
  const findings = [];
  const checks = [];
  const config = projectConfig(project);
  const note = (name, ok, detail = null) => checks.push({ name, ok, ...(detail ? { detail } : {}) });

  if (project.plan.template === "static-site") {
    for (const page of config.pages) {
      const path = page.id === "home" ? "/" : `/${page.id}.html`;
      const response = await fetch(`${base}${path}`).catch((error) => ({ status: 0, text: async () => error.message }));
      const html = await response.text();
      const ok = response.status === 200 && html.includes(`<h1>`) && html.includes(page.headline.replace(/&/gu, "&amp;"));
      note(`page ${path}`, ok);
      if (!ok) findings.push(finding("page-loads", path, `200 with heading "${page.headline}"`, `status ${response.status}`));
    }
    const bad = await api(base, "/api/enquiries", { method: "POST", body: JSON.stringify({ name: "" }) });
    note("enquiry rejects empty", bad.status === 400);
    if (bad.status !== 400) findings.push(finding("form-validation", "/contact.html", "400 for an empty enquiry", `status ${bad.status}`));
  } else {
    if (project.plan.template === "web-app") {
      for (const path of ["/", "/app.js", "/styles.css"]) {
        const response = await fetch(`${base}${path}`).catch(() => ({ status: 0 }));
        note(`asset ${path}`, response.status === 200);
        if (response.status !== 200) findings.push(finding("asset-loads", path, "200", `status ${response.status}`));
      }
    }
    const session = await inspectorSession(base, config, note, findings);
    const headers = session.headers;
    for (const entity of session.signedIn ? config.entities : []) {
      const marker = Math.random().toString(36).slice(2, 8);
      const record = Object.fromEntries(entity.fields.map((field) => [field.key, sampleValue(field, marker)]));
      const created = await api(base, `/api/${entity.slug}`, { method: "POST", body: JSON.stringify(record), headers });
      note(`${entity.slug} create`, created.status === 201);
      if (created.status !== 201) { findings.push(finding("workflow-create", `/api/${entity.slug}`, "201 Created", `${created.status} ${JSON.stringify(created.body).slice(0, 200)}`)); continue; }
      const id = created.body.record.id;
      const search = await api(base, `/api/${entity.slug}?q=${marker}`, { headers });
      const found = search.status === 200 && search.body.records?.some((r) => r.id === id);
      note(`${entity.slug} search`, found);
      if (!found) findings.push(finding("workflow-search", `/api/${entity.slug}?q=`, "the new record is found by search", `status ${search.status}`));
      const invalid = entity.fields.find((f) => f.required) ? await api(base, `/api/${entity.slug}`, { method: "POST", body: JSON.stringify({}), headers }) : { status: 400 };
      note(`${entity.slug} validation`, invalid.status === 400);
      if (invalid.status !== 400) findings.push(finding("validation", `/api/${entity.slug}`, "400 for a record missing required fields", `status ${invalid.status}`));
      const removed = await api(base, `/api/${entity.slug}/${id}`, { method: "DELETE", headers });
      note(`${entity.slug} delete`, removed.status === 200);
    }
    await session.end();
  }
  return { ok: findings.length === 0, findings, limited: project.plan.template !== "api-service", evidence: { mode: "http", checks } };
}

/** Browser inspection through Playwright. Returns null when no browser can be launched. */
export async function inspectInBrowser(project, preview, { artifactsDir = null, playwright = null, launchOptions = {} } = {}) {
  const engine = playwright ?? (await loadPlaywright());
  if (!engine?.chromium) return null;
  let browser;
  try {
    browser = await engine.chromium.launch({ headless: true, ...launchOptions });
  } catch {
    return null;
  }
  const findings = [];
  const checks = [];
  const screenshots = [];
  const config = projectConfig(project);
  const base = preview.url;
  if (artifactsDir) mkdirSync(artifactsDir, { recursive: true });
  const note = (name, ok, detail = null) => checks.push({ name, ok, ...(detail ? { detail } : {}) });

  async function openPage(width) {
    const context = await browser.newContext({ viewport: { width, height: width < 500 ? 780 : 860 } });
    const page = await context.newPage();
    const errors = [];
    page.on("console", (message) => { if (message.type() === "error") errors.push(`console: ${message.text()}`); });
    page.on("pageerror", (error) => errors.push(`exception: ${error.message}`));
    return { context, page, errors };
  }

  async function visit(page, errors, path, expectedHeading, width) {
    const before = errors.length;
    const response = await page.goto(`${base}${path}`, { waitUntil: "load", timeout: 15_000 }).catch((error) => ({ status: () => 0, error }));
    await page.waitForFunction(() => { const h = document.querySelector("main h1, h1"); return h && !/^Loading/u.test(h.textContent); }, null, { timeout: 8_000 }).catch(() => {});
    const heading = await page.locator("h1").first().textContent({ timeout: 2_000 }).catch(() => null);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth).catch(() => 0);
    const label = `${path} @${width}px`;
    // A hash route in an already-open app is a same-document navigation: no response, not a failure.
    const status = response === null ? 200 : response?.status?.() ?? 0;
    if (status !== 200) findings.push(finding("page-loads", label, "status 200", `status ${status}`));
    if (expectedHeading && (!heading || !heading.trim().toLowerCase().includes(expectedHeading.toLowerCase()))) findings.push(finding("heading", label, `heading "${expectedHeading}"`, heading ? `heading "${heading.trim()}"` : "no heading"));
    if (overflow > 2) findings.push(finding("layout-overflow", label, "no horizontal scrolling", `${overflow}px wider than the screen`, width < 500 ? "error" : "warning"));
    for (const error of errors.slice(before)) findings.push(finding("runtime-error", label, "no console errors or exceptions", error));
    note(label, status === 200 && errors.length === before);
    if (artifactsDir) {
      const file = join(artifactsDir, `${path.replace(/[^a-z0-9]+/giu, "_") || "home"}-${width}.png`);
      await page.screenshot({ path: file, fullPage: true }).catch(() => {});
      screenshots.push(file);
    }
  }

  let session = { headers: {}, cookie: null, signedIn: true, end: async () => {} };
  const signedIn = (context) => (session.cookie
    ? context.addCookies([{ name: session.cookie.split("=")[0], value: session.cookie.slice(session.cookie.indexOf("=") + 1), url: base }])
    : Promise.resolve());
  try {
    if (project.plan.template !== "static-site" && config.auth?.required) {
      // A signed-out visitor sees the sign-in screen, not the app.
      const { context, page, errors } = await openPage(1280);
      await visit(page, errors, "/#/dashboard", null, 1280);
      const heading = (await page.locator("h1").first().textContent({ timeout: 2_000 }).catch(() => "")) ?? "";
      const gated = /sign in|set up your account/iu.test(heading);
      note("signed out: the sign-in screen is shown", gated);
      if (!gated) findings.push(finding("auth-required", "/#/dashboard", "the sign-in screen when signed out", `heading "${heading.trim()}"`));
      await context.close();
      session = await inspectorSession(base, config, note, findings);
    }
    const pages = project.plan.template === "static-site"
      ? config.pages.map((page) => ({ path: page.id === "home" ? "/" : `/${page.id}.html`, heading: page.headline }))
      : [
        ...(config.booking ? [{ path: "/#/book", heading: config.booking.title }] : []),
        { path: "/#/dashboard", heading: "Dashboard" },
        ...config.entities.map((entity) => ({ path: `/#/${entity.slug}`, heading: entity.plural })),
        ...(config.files && config.files.enabled !== false ? [{ path: "/#/files", heading: "Files" }] : []),
      ];
    for (const width of [1280, 375]) {
      if (!session.signedIn) break;
      const { context, page, errors } = await openPage(width);
      await signedIn(context);
      for (const target of pages) await visit(page, errors, target.path, target.heading, width);
      await context.close();
    }

    const { context, page, errors } = await openPage(1280);
    await signedIn(context);
    if (project.plan.template === "static-site") {
      const before = errors.length;
      await page.goto(`${base}/contact.html`, { waitUntil: "load" });
      await page.click("#enquiry button[type=submit]");
      const shownError = await page.locator("#enquiry-error").waitFor({ state: "visible", timeout: 5_000 }).then(() => true).catch(() => false);
      note("enquiry: empty form shows an error", shownError);
      if (!shownError) findings.push(finding("workflow-enquiry", "/contact.html", "an error for an empty form", "no error shown"));
      await page.fill("#name", "Atlas check");
      await page.fill("#email", "atlas.check@example.com");
      await page.fill("#message", "Checked by Atlas");
      await page.click("#enquiry button[type=submit]");
      const done = await page.locator("#enquiry-done").waitFor({ state: "visible", timeout: 5_000 }).then(() => true).catch(() => false);
      note("enquiry: valid form is sent", done);
      if (!done) findings.push(finding("workflow-enquiry", "/contact.html", "a confirmation after sending", "no confirmation"));
      for (const error of errors.slice(before)) findings.push(finding("runtime-error", "/contact.html", "no console errors", error));
    } else {
      for (const entity of session.signedIn ? config.entities : []) {
        const marker = Math.random().toString(36).slice(2, 8);
        const before = errors.length;
        await page.goto(`${base}/#/${entity.slug}/new`, { waitUntil: "load" });
        await page.waitForSelector("form", { timeout: 8_000 }).catch(() => {});
        for (const field of entity.fields) {
          const selector = `#f-${field.key}`;
          if (field.type === "select") await page.selectOption(selector, sampleValue(field, marker)).catch(() => {});
          else await page.fill(selector, sampleValue(field, marker)).catch(() => {});
        }
        await page.click("form button[type=submit]");
        const saved = await page.waitForFunction((slug) => /^#\/[^/]+\/\d+$/u.test(location.hash) && location.hash.startsWith(`#/${slug}/`), entity.slug, { timeout: 8_000 }).then(() => true).catch(() => false);
        note(`add ${entity.name.toLowerCase()} through the form`, saved);
        if (!saved) { findings.push(finding("workflow-add", `/#/${entity.slug}/new`, `saving a ${entity.name.toLowerCase()} opens it`, `stayed on ${await page.evaluate(() => location.hash)}`)); continue; }
        const id = await page.evaluate(() => location.hash.split("/").at(-1));
        await page.goto(`${base}/#/${entity.slug}`, { waitUntil: "load" });
        await page.fill("#search", marker).catch(() => {});
        const listed = await page.locator("table tbody tr").filter({ hasText: marker }).first().waitFor({ timeout: 6_000 }).then(() => true).catch(() => false);
        const rows = await page.locator("table tbody tr").count().catch(() => 0);
        note(`find ${entity.name.toLowerCase()} by search`, listed && rows === 1);
        if (!listed || rows !== 1) findings.push(finding("workflow-search", `/#/${entity.slug}`, "search shows only the matching record", `${rows} row(s) shown`));
        for (const error of errors.slice(before)) findings.push(finding("runtime-error", `/#/${entity.slug}`, "no console errors", error));
        await fetch(`${base}/api/${entity.slug}/${id}`, { method: "DELETE", headers: session.headers }).catch(() => {});
      }
      if (config.booking) {
        const entity = config.entities.find((candidate) => candidate.slug === config.booking.entity);
        const marker = Math.random().toString(36).slice(2, 8);
        await page.goto(`${base}/#/book`, { waitUntil: "load" });
        await page.waitForSelector("form", { timeout: 8_000 }).catch(() => {});
        for (const field of entity.fields.filter((f) => f.key !== "status")) {
          const selector = `#book-${field.key}`;
          if (field.type === "select") await page.selectOption(selector, sampleValue(field, marker)).catch(() => {});
          else await page.fill(selector, sampleValue(field, marker)).catch(() => {});
        }
        await page.click("form button[type=submit]");
        const thanked = await page.getByText("Thank you").first().waitFor({ timeout: 6_000 }).then(() => true).catch(() => false);
        note("book an appointment", thanked);
        if (!thanked) findings.push(finding("workflow-booking", "/#/book", "a confirmation after booking", "no confirmation"));
        const booked = await api(base, `/api/${entity.slug}?q=${marker}`, { headers: session.headers });
        for (const record of booked.body?.records ?? []) await fetch(`${base}/api/${entity.slug}/${record.id}`, { method: "DELETE", headers: session.headers }).catch(() => {});
      }
    }
    await context.close();
  } finally {
    await session.end().catch(() => {});
    await browser.close().catch(() => {});
  }
  const blocking = findings.filter((f) => f.severity === "error");
  return { ok: blocking.length === 0, findings, limited: false, evidence: { mode: "browser", checks, screenshots, warnings: findings.filter((f) => f.severity !== "error").length } };
}

/** The inspector Genesis uses: a browser when one launches, HTTP otherwise (flagged as limited). */
/**
 * The inspector Genesis uses: a browser when one launches, HTTP otherwise
 * (flagged as limited). With a `vision` reviewer (vision.mjs), a clean
 * browser inspection's screenshots are also reviewed visually; its blocking
 * findings join the others, and its suggestions go to the polish step.
 */
export function createInspector({ artifactsRoot = null, playwright = null, launchOptions = {}, vision = null } = {}) {
  return async (project, preview) => {
    if (project.plan.template !== "api-service") {
      const browser = await inspectInBrowser(project, preview, { artifactsDir: artifactsRoot ? join(artifactsRoot, project.id) : null, playwright, launchOptions });
      if (browser) {
        if (!vision || !browser.ok) return browser;
        const visual = await vision(project, browser.evidence.screenshots).catch((error) => ({ reviewed: false, reason: String(error?.message ?? error), findings: [] }));
        const findings = [...browser.findings, ...visual.findings];
        return {
          ...browser,
          ok: !findings.some((f) => f.severity === "error"),
          findings,
          evidence: { ...browser.evidence, visual: { reviewed: visual.reviewed, model: visual.model ?? null, reason: visual.reason ?? null, issues: visual.findings.length } },
        };
      }
    }
    return inspectOverHttp(project, preview);
  };
}
