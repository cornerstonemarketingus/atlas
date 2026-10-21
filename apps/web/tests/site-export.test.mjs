import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import ts from "typescript";
import { readFile } from "node:fs/promises";
import { getTemplate } from "../../local-control/src/platform/genesis/templates/index.mjs";
import { generateSiteTemplateSource } from "../scripts/generate-site-template.mjs";
import { createHostedSite } from "../app/api/genesis/hosted-site.mjs";
import { MAX_EXPORT_BYTES, buildDist, buildSiteExport, projectFiles, serveSiteExport, slugOf } from "../app/api/genesis/site-export.mjs";
import { SITE_TEMPLATE_FILES } from "../app/api/genesis/site-template.mjs";
import { NO_TENANT_MESSAGE, tenantScope } from "../app/api/auth/tenant-context.mjs";
import { hostedHarness } from "./helpers/hosted.mjs";

const HAHN = "Build a responsive website for Team Hahn Construction in Eagan, Minnesota, specializing in wood framing, windows, doors, and housewrap.";
const uuid = (n) => `${String(n).padStart(8, "0")}-aaaa-4bbb-8ccc-dddddddddddd`;
const mine = { tenantId: 1, principal: "github:customer" };

async function seeded(requestId = uuid(1), scope = mine) {
  const harness = hostedHarness();
  const created = await createHostedSite({ store: harness.store, scope, requestId, userMessage: HAHN });
  assert.equal(created.status, "ready");
  return { ...harness, id: created.projectId, row: await harness.store.get(scope, created.projectId) };
}

/** Unzip with a real implementation into an empty directory. */
function unzipTo(file, directory) {
  const result = spawnSync("unzip", ["-q", file, "-d", directory], { encoding: "utf8" });
  if (result.error) {
    const python = spawnSync("python3", ["-I", "-m", "zipfile", "-e", file, directory], { encoding: "utf8" });
    assert.equal(python.status, 0, python.stderr);
  } else assert.equal(result.status, 0, result.stdout + result.stderr);
}

function readTree(directory, base = directory, out = {}) {
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) readTree(path, base, out);
    else out[path.slice(base.length + 1)] = readFileSync(path, "utf8");
  }
  return out;
}

test("the embedded template is the template: regenerate with `node scripts/generate-site-template.mjs` when this fails", async () => {
  const current = await readFile(new URL("../app/api/genesis/site-template.mjs", import.meta.url), "utf8");
  assert.equal(current, generateSiteTemplateSource());
});

test("package.json, README, site.json and .gitignore match what local Genesis generates", async () => {
  const { row } = await seeded();
  const { spec, site } = JSON.parse(row.requirementsJson);
  const expected = getTemplate("static-site").configure(spec);
  const files = projectFiles(spec, site);
  for (const name of Object.keys(expected)) assert.equal(files[name], expected[name], name);
  for (const name of Object.keys(SITE_TEMPLATE_FILES)) assert.equal(files[name], SITE_TEMPLATE_FILES[name], name);
});

test("the archive holds a complete project and a site-relative dist/ under one folder", async () => {
  const { row } = await seeded();
  const built = buildSiteExport(row);
  assert.equal(built.ok, true);
  assert.equal(built.filename, "team-hahn-construction-website.zip");
  const directory = mkdtempSync(join(tmpdir(), "export-list-"));
  try {
    const file = join(directory, "x.zip");
    writeFileSync(file, built.bytes);
    unzipTo(file, join(directory, "out"));
    const tree = readTree(join(directory, "out", "team-hahn-construction"));
    for (const name of ["site.json", "package.json", "README.md", ".gitignore", "server.mjs", "scripts/render.mjs", "scripts/build.mjs", "scripts/check.mjs", "src/styles.css", "src/contact.js", "src/http.mjs", "tests/site.test.mjs", "dist/index.html", "dist/contact.html", "dist/styles.css", "dist/contact.js", "dist/sitemap.xml", "dist/robots.txt"]) assert.ok(name in tree, name);
    assert.match(tree["dist/index.html"], /href="\/styles\.css"/u);
    assert.doesNotMatch(tree["dist/index.html"], /\/preview\//u, "no preview-relative links or banner");
    assert.doesNotMatch(tree["dist/index.html"], /atlas-preview-bar/u);
    assert.match(tree["dist/index.html"], /Team Hahn Construction/u);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("the unzipped project passes its own check, tests and build, and dist/ equals a fresh build", { timeout: 120_000 }, async () => {
  const { row } = await seeded();
  const built = buildSiteExport(row);
  const directory = mkdtempSync(join(tmpdir(), "export-run-"));
  try {
    const file = join(directory, "site.zip");
    writeFileSync(file, built.bytes);
    unzipTo(file, join(directory, "out"));
    const root = join(directory, "out", "team-hahn-construction");
    const shipped = Object.fromEntries(Object.entries(readTree(join(root, "dist"))));
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const run = (...args) => spawnSync(process.execPath, args, { cwd: root, encoding: "utf8", env });
    const check = run("scripts/check.mjs");
    assert.equal(check.status, 0, check.stdout + check.stderr);
    const tests = run("--test", "--test-reporter=tap");
    assert.equal(tests.status, 0, tests.stdout + tests.stderr);
    assert.match(tests.stdout, /# fail 0/u);
    const build = run("scripts/build.mjs");
    assert.equal(build.status, 0, build.stdout + build.stderr);
    assert.deepEqual(readTree(join(root, "dist")), shipped, "a fresh build reproduces the shipped dist/");
    assert.deepEqual(shipped, Object.fromEntries(Object.entries(buildDist(JSON.parse(readFileSync(join(root, "site.json"), "utf8")))).map(([k, v]) => [k, v])));
    // The project is self-contained: no dependencies to install.
    assert.deepEqual(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).dependencies, {});
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("filenames are sanitized", () => {
  assert.equal(slugOf("Team Hahn Construction"), "team-hahn-construction");
  assert.equal(slugOf('../../"evil"\r\nSet-Cookie: x=1'), "evil-set-cookie-x-1");
  assert.equal(slugOf("日本語"), "website");
  assert.equal(slugOf("Café Ünï"), "cafe-uni");
  assert.ok(slugOf("a".repeat(200)).length <= 60);
});

test("serving: ZIP headers, no-store, and 404 for everything that is not the caller's hosted site", async () => {
  const { store, sqlite, id } = await seeded();
  const response = await serveSiteExport({ id, store, scope: mine });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/zip");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("content-disposition"), 'attachment; filename="team-hahn-construction-website.zip"');
  const body = new Uint8Array(await response.arrayBuffer());
  assert.equal(Number(response.headers.get("content-length")), body.length);
  assert.ok(body.length < MAX_EXPORT_BYTES);
  assert.deepEqual([...body.slice(0, 4)], [0x50, 0x4b, 0x03, 0x04]);

  const missing = await serveSiteExport({ id: `gen_${uuid(9)}`, store, scope: mine });
  const otherUser = await serveSiteExport({ id, store, scope: { tenantId: 1, principal: "github:other" } });
  const otherTenant = await serveSiteExport({ id, store, scope: { tenantId: 2, principal: mine.principal } });
  const malformed = await serveSiteExport({ id: "../etc/passwd", store, scope: mine });
  for (const denied of [otherUser, otherTenant, malformed]) {
    assert.equal(denied.status, 404);
    assert.equal(await denied.clone().text(), await missing.clone().text(), "indistinguishable from missing");
    assert.equal(denied.headers.get("cache-control"), "no-store");
  }
  // A node-built (non-hosted) project is not exportable.
  sqlite.prepare("INSERT INTO genesis_projects (id, tenant_id, requested_by, prompt, name, requirements_json, status) VALUES (?, 1, ?, 'p', 'n', '{\"objective\":\"p\"}', 'ready')").run(`gen_${uuid(5)}`, mine.principal);
  assert.equal((await serveSiteExport({ id: `gen_${uuid(5)}`, store, scope: mine })).status, 404);
  sqlite.exec("DROP TABLE genesis_projects");
  assert.equal((await serveSiteExport({ id, store, scope: mine })).status, 503);
});

test("a site over the size cap is refused with 413", async () => {
  const { row } = await seeded();
  const stored = JSON.parse(row.requirementsJson);
  stored.spec.objective = "x".repeat(MAX_EXPORT_BYTES + 1);
  assert.deepEqual(buildSiteExport({ ...row, requirementsJson: JSON.stringify(stored) }), { ok: false, code: "too-large" });
});

async function route(path, dependencies) {
  const source = await readFile(new URL(path, import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    transformers: { before: [() => (root) => ts.factory.updateSourceFile(root, root.statements.filter((node) => !ts.isImportDeclaration(node)))] },
  }).outputText.replaceAll("export async function", "async function").replace(/export \{\};?/gu, "");
  return new Function(...Object.keys(dependencies), `${compiled}; return { GET };`)(...Object.values(dependencies));
}

test("the export route needs sign-in and a workspace, then serves only the caller's site", async () => {
  const { d1, store, id } = await seeded();
  const load = async (account, tenant) => (await route("../app/api/genesis/projects/[id]/export/route.ts", {
    getD1: () => d1, hostedSiteStore: () => store, tenantScope, NO_TENANT_MESSAGE, serveSiteExport,
    authenticatedAccount: async () => account, resolveTenantContext: async () => tenant,
  })).GET;
  const call = async (get, target = id) => get(new Request(`https://atlas.test/api/genesis/projects/${target}/export`), { params: Promise.resolve({ id: target }) });
  const signedIn = { userId: mine.principal };
  assert.equal((await call(await load(null, null))).status, 401);
  assert.equal((await call(await load(signedIn, null))).status, 403);
  const ok = await call(await load(signedIn, mine));
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("content-type"), "application/zip");
  assert.equal((await call(await load({ userId: "github:other" }, { tenantId: 1, principal: "github:other" }))).status, 404);
  assert.equal((await call(await load(signedIn, mine), "nope")).status, 404);
});

test("rendering base '' is what the shipped dist uses (links are site-relative)", async () => {
  const { row } = await seeded();
  const { site } = JSON.parse(row.requirementsJson);
  const dist = buildDist(site);
  for (const html of Object.entries(dist).filter(([name]) => name.endsWith(".html")).map(([, body]) => body)) assert.doesNotMatch(html, /(?:href|src)="https?:/u);
});
