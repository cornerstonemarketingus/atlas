import { createRenderer, validateSite } from "../../../../local-control/src/platform/genesis/templates/static-site/files/scripts/render.mjs";
import { HOSTED_KIND, PREVIEW_ID, isHostedRow } from "./hosted-site.mjs";
import { SITE_TEMPLATE, SITE_TEMPLATE_FILES } from "./site-template.mjs";
import { writeZip } from "./zip.mjs";

/**
 * Take your website with you: a ZIP of the same runnable Genesis static-site
 * project local Genesis would generate, plus a prebuilt dist/ rendered with
 * site-relative links so it can be dropped on any static host.
 *
 * Everything is derived from the stored site.json and specification; nothing
 * is executed. The project's own files come from the embedded template
 * (site-template.mjs, drift-tested). package.json, README and .gitignore mirror
 * the Genesis template's `configure`; tests/site-export.test.mjs compares them.
 */

export const MAX_EXPORT_BYTES = 5 * 1024 * 1024;
const GITIGNORE = "node_modules/\ndist/\ndata/\n*.log\n.DS_Store\n";

export const exportPath = (id) => `/api/genesis/projects/${id}/export`;

/** A safe slug for file and package names. */
export function slugOf(name, fallback = "website") {
  return String(name ?? "").toLowerCase().normalize("NFKD").replace(/\p{M}/gu, "").replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "").slice(0, 60).replace(/-$/u, "") || fallback;
}

function packageJson(spec, name) {
  const slug = String(name ?? "").toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "").slice(0, 60) || "atlas-app";
  const scripts = { start: "node scripts/build.mjs && node server.mjs", check: "node scripts/check.mjs", test: "node --test --test-reporter=tap", build: "node scripts/build.mjs" };
  return `${JSON.stringify({ name: slug, version: "0.1.0", private: true, type: "module", engines: { node: ">=22.13.0" }, scripts, dependencies: {} }, null, 2)}\n`;
}

function readme(spec) {
  const workflows = (spec.workflows ?? []).map((flow) => `- ${flow.title}`);
  const pages = spec.pages?.length ? [`- Pages: ${spec.pages.map((page) => page.title).join(", ")}`] : [];
  return `# ${spec.name}

${spec.objective}

Created by Atlas Genesis from the \`${SITE_TEMPLATE.id}\` template (v${SITE_TEMPLATE.version}).

## Run it

\`\`\`
npm start        # builds, then serves http://127.0.0.1:3000
npm test
npm run build     # static files in dist/
\`\`\`

## What it does

${[...workflows, ...pages].join("\n")}

## Assumptions

${(spec.assumptions ?? []).map((line) => `- ${line}`).join("\n")}
`;
}

/** The prebuilt dist/, exactly what `node scripts/build.mjs` writes. */
export function buildDist(site) {
  const renderer = createRenderer(site);
  const dist = {};
  for (const page of site.pages) dist[renderer.fileFor(page)] = renderer.render(page);
  dist["styles.css"] = SITE_TEMPLATE_FILES["src/styles.css"];
  dist["contact.js"] = SITE_TEMPLATE_FILES["src/contact.js"];
  dist["sitemap.xml"] = renderer.sitemap();
  dist["robots.txt"] = renderer.robots();
  return dist;
}

/** Every file of the exported project, relative to its root. */
export function projectFiles(spec, site) {
  const files = {
    ...SITE_TEMPLATE_FILES,
    "site.json": `${JSON.stringify(site, null, 2)}\n`,
    "package.json": packageJson(spec, spec.name),
    "README.md": readme(spec),
    ".gitignore": GITIGNORE,
  };
  for (const [name, body] of Object.entries(buildDist(site))) files[`dist/${name}`] = body;
  return files;
}

/** @returns {{ ok: true, filename: string, bytes: Uint8Array } | { ok: false, code: "not-exportable" | "too-large" }} */
export function buildSiteExport(row) {
  if (!isHostedRow(row)) return { ok: false, code: "not-exportable" };
  let stored;
  try { stored = JSON.parse(row.requirementsJson); } catch { return { ok: false, code: "not-exportable" }; }
  if (stored.kind !== HOSTED_KIND || !stored.site || !stored.spec || validateSite(stored.site).length) return { ok: false, code: "not-exportable" };
  const root = slugOf(stored.site.name);
  const files = projectFiles(stored.spec, stored.site);
  const bytes = writeZip(Object.keys(files).sort().map((path) => ({ name: `${root}/${path}`, data: files[path] })));
  if (bytes.length > MAX_EXPORT_BYTES) return { ok: false, code: "too-large" };
  return { ok: true, filename: `${root}-website.zip`, bytes };
}

const baseHeaders = { "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" };
const plain = (status, message) => new Response(`${message}\n`, { status, headers: { ...baseHeaders, "content-type": "text/plain; charset=utf-8" } });

/**
 * GET /api/genesis/projects/<id>/export. The caller has already signed in and
 * resolved a tenant scope; a project that is not theirs, not hosted or not
 * well-formed is the same 404 as a missing one.
 * @param {{ id: string, store: { get: Function }, scope: { tenantId: number, principal: string } }} input
 */
export async function serveSiteExport({ id, store, scope }) {
  const missing = () => plain(404, "Not found.");
  if (!PREVIEW_ID.test(String(id))) return missing();
  let row;
  try { row = await store.get(scope, id); } catch { return plain(503, "Exports are temporarily unavailable."); }
  if (!row) return missing();
  const built = buildSiteExport(row);
  if (!built.ok) return built.code === "too-large" ? plain(413, "This website is too large to export.") : missing();
  return new Response(built.bytes, {
    status: 200,
    headers: { ...baseHeaders, "content-type": "application/zip", "content-disposition": `attachment; filename="${built.filename}"`, "content-length": String(built.bytes.length) },
  });
}
