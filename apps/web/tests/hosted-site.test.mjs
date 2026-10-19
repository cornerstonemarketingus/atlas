import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { inferSpecification } from "../../local-control/src/platform/genesis/requirements.mjs";
import { siteConfig } from "../../local-control/src/platform/genesis/templates/site-config.mjs";
import { hostedSiteStore } from "../db/hosted-sites.mjs";
import { servePreview } from "../app/api/genesis/hosted-preview.mjs";
import { HOSTED_SITE_DAILY_LIMIT, PREVIEW_ID, createHostedSite, planHostedSite, verifyHostedSite } from "../app/api/genesis/hosted-site.mjs";
import { projectBackend } from "../app/api/genesis/project-backend.mjs";
import { SITE_STYLES } from "../app/api/genesis/site-assets.mjs";
import { createProjectTools } from "../app/api/chat/project-tools.mjs";
import { genesisBridge } from "../app/api/genesis/bridge.mjs";
import { migratedDatabase } from "./helpers/d1-sqlite.mjs";

const HAHN = "Build a responsive website for Team Hahn Construction in Eagan, Minnesota, specializing in wood framing, windows, doors, and housewrap.";
const uuid = (n = 1) => `${String(n).padStart(8, "0")}-aaaa-4bbb-8ccc-dddddddddddd`;
const scope = { tenantId: 1, principal: "github:owner" };

function harness() {
  const { sqlite, d1 } = migratedDatabase({ users: [[1, "owner"]] });
  sqlite.prepare("INSERT INTO tenants (id, slug, name, owner_principal) VALUES (2, 'other', 'Other', 'github:other')").run();
  return { sqlite, d1, store: hostedSiteStore(d1) };
}

test("the hosted plan is Genesis's own specification and site, not a second builder", () => {
  const plan = planHostedSite({ userMessage: HAHN });
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.site, siteConfig(inferSpecification(HAHN)));
  assert.equal(plan.site.name, "Team Hahn Construction");
  assert.deepEqual(plan.site.pages.map((page) => page.id), ["home", "services", "about", "gallery", "contact"]);
  assert.match(plan.site.pages[0].headline, /Eagan, Minnesota/u);
  // The person's own words win over a vaguer paraphrase from the model.
  assert.equal(planHostedSite({ userMessage: HAHN, description: "a construction website" }).site.name, "Team Hahn Construction");
  assert.equal(planHostedSite({ userMessage: "ok go", description: HAHN }).site.name, "Team Hahn Construction");
});

test("apps, APIs and empty requests are not built by the hosted path", () => {
  assert.equal(planHostedSite({ userMessage: "Build a REST API for inventory items" }).code, "UNSUPPORTED_HOSTED_PROJECT");
  assert.equal(planHostedSite({ userMessage: "Build a customer lead tracker with search" }).code, "UNSUPPORTED_HOSTED_PROJECT");
  assert.equal(planHostedSite({ userMessage: HAHN, template: "web-app" }).code, "UNSUPPORTED_HOSTED_PROJECT");
  assert.equal(planHostedSite({ userMessage: "   " }).code, "INVALID_PROJECT");
});

test("verification checks the real rendered pages and never claims a browser pass", () => {
  const { site } = planHostedSite({ userMessage: HAHN });
  const id = `gen_${uuid()}`;
  const report = verifyHostedSite(site, id);
  assert.equal(report.ok, true);
  assert.equal(report.pages, 5);
  assert.equal(report.browserChecks, "not-run");
  assert.equal(report.enquiryDelivery, "preview-only");
  assert.equal(report.checks.length, 5 * 7 + 4);
  assert.ok(report.ownerContentNeeded >= 2, "missing business facts are counted, not hidden");
  // Weakening the site makes the matching check fail.
  const noHeading = structuredClone(site); noHeading.pages[1].headline = "";
  assert.equal(verifyHostedSite(noHeading, id).ok, false);
  const longDescription = structuredClone(site); longDescription.pages[2].description = "x".repeat(200);
  assert.equal(verifyHostedSite(longDescription, id).ok, false);
});

test("creating a site persists it for its workspace, is idempotent, and is invisible to other principals", async () => {
  const { store, sqlite } = harness();
  const first = await createHostedSite({ store, scope, requestId: uuid(), userMessage: HAHN });
  assert.equal(first.status, "ready");
  assert.equal(first.hosted, true);
  assert.equal(first.operationId, `gen_${uuid()}`);
  assert.match(first.previewUrl, /^\/preview\/gen_[0-9a-f-]{36}$/u);
  assert.equal(first.repository, null);
  assert.equal(first.deploymentState, "not-deployed");
  assert.equal(first.verification.browserChecks, "not-run");
  assert.match(first.message, /nothing is published/iu);
  const again = await createHostedSite({ store, scope, requestId: uuid(), userMessage: HAHN });
  assert.equal(again.operationId, first.operationId);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM genesis_projects").get().n, 1);
  assert.ok(await store.get(scope, first.operationId));
  assert.equal(await store.get({ tenantId: 1, principal: "github:someone-else" }, first.operationId), null);
  assert.equal(await store.get({ tenantId: 2, principal: "github:owner" }, first.operationId), null);
});

test("hosted creation has a daily per-workspace limit that other workspaces do not share", async () => {
  const { store } = harness();
  for (let index = 1; index <= HOSTED_SITE_DAILY_LIMIT; index++) assert.equal((await createHostedSite({ store, scope, requestId: uuid(index), userMessage: HAHN })).status, "ready");
  const refused = await createHostedSite({ store, scope, requestId: uuid(99), userMessage: HAHN });
  assert.equal(refused.status, "failed");
  assert.equal(refused.code, "RATE_LIMITED");
  assert.equal((await createHostedSite({ store, scope: { tenantId: 2, principal: "github:other" }, requestId: uuid(100), userMessage: HAHN })).status, "ready");
});

test("a missing table is reported as unavailable with the fix, not as success", async () => {
  const { store, sqlite } = harness();
  sqlite.exec("DROP TABLE genesis_projects");
  const result = await createHostedSite({ store, scope, requestId: uuid(), userMessage: HAHN });
  assert.equal(result.status, "unavailable");
  assert.equal(result.reason, "storage_not_ready");
  assert.match(result.nextStep, /0016_project_genesis/u);
});

test("the preview serves real pages, assets and a sandboxing CSP, and refuses anything else", async () => {
  const { d1, store, sqlite } = harness();
  const created = await createHostedSite({ store, scope, requestId: uuid(), userMessage: HAHN });
  const id = created.operationId;
  const get = (file = "", target = id) => servePreview({ id: target, file, database: () => d1 });
  const home = await get();
  assert.equal(home.status, 200);
  const html = await home.text();
  assert.match(html, /<h1>Team Hahn Construction in Eagan, Minnesota<\/h1>/u);
  assert.match(html, /Atlas preview\. This site is not published\./u);
  assert.match(html, /<link rel="icon" href="data:,">/u, "no favicon request reaches the app");
  assert.match(html, new RegExp(`href="/preview/${id}/services.html"`, "u"));
  assert.match(home.headers.get("content-security-policy"), /script-src 'self'/u);
  assert.match(home.headers.get("content-security-policy"), /form-action 'none'/u);
  assert.equal(home.headers.get("x-robots-tag"), "noindex, nofollow");
  assert.equal(home.headers.get("cache-control"), "no-store");
  for (const file of ["services.html", "about.html", "gallery.html", "contact.html"]) assert.equal((await get(file)).status, 200, file);
  const contact = await (await get("contact.html")).text();
  assert.match(contact, /id="enquiry"/u);
  assert.match(contact, new RegExp(`src="/preview/${id}/contact.js"`, "u"));
  const script = await (await get("contact.js")).text();
  assert.match(script, /enquiries are not sent/u);
  assert.doesNotMatch(script, /fetch\(/u, "the preview never posts the form anywhere");
  const css = await (await get("styles.css")).text();
  assert.ok(css.startsWith(SITE_STYLES));
  for (const bad of ["nope.html", "../x.html", "styles.css%00", "a.php", "INDEX.HTML"]) assert.equal((await get(bad)).status, 404, bad);
  assert.equal((await get("", "gen_not-a-uuid")).status, 404);
  assert.equal((await get("", `gen_${uuid(7)}`)).status, 404);
  // A project the node-oriented route created is not a hosted site and never previews.
  sqlite.prepare("INSERT INTO genesis_projects (id, tenant_id, requested_by, prompt, name, requirements_json, status) VALUES (?, 1, 'x', 'p', 'n', '{\"objective\":\"p\"}', 'planned')").run(`gen_${uuid(8)}`);
  assert.equal((await get("", `gen_${uuid(8)}`)).status, 404);
  sqlite.exec("DROP TABLE genesis_projects");
  assert.equal((await get()).status, 503);
});

test("preview pages escape every stored string", async () => {
  const { d1, store } = harness();
  const hostile = "<img src=x onerror=alert(1)>";
  const { site, spec } = planHostedSite({ userMessage: HAHN });
  site.name = hostile; site.tagline = hostile; site.pages[0].headline = hostile; site.pages[0].intro = hostile;
  site.pages[0].sections[0].items[0].title = hostile; site.pages[0].sections[0].items[0].text = hostile;
  const id = `gen_${uuid(5)}`;
  await store.insert({ id, tenantId: 1, requestedBy: "github:owner", prompt: "p", name: "n", requirementsJson: JSON.stringify({ kind: "hosted-static-site", spec, site }), status: "ready", repository: null, previewUrl: `/preview/${id}`, deploymentUrl: null, evidenceJson: "[]", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" });
  const html = await (await servePreview({ id, database: () => d1 })).text();
  assert.doesNotMatch(html, /<img src=x/u);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/u);
});

test("the embedded stylesheet is the template's stylesheet", () => {
  const template = readFileSync(new URL("../../local-control/src/platform/genesis/templates/static-site/files/src/styles.css", import.meta.url), "utf8");
  assert.equal(SITE_STYLES, template);
});

test("a node is used first when it answers; otherwise a website is built here; apps keep the node's reason", async () => {
  const { store } = harness();
  const hosted = { store, scope };
  const node = (result) => ({ available: true, create: async () => result, status: async () => ({ status: "building", projectState: "verifying" }) });
  const viaNode = await projectBackend({ bridge: node({ status: "building", operationId: "node-op-1234567890ab" }), hosted, userMessage: HAHN }).create({ requestId: uuid(1) });
  assert.equal(viaNode.operationId, "node-op-1234567890ab");
  const nodeDown = await projectBackend({ bridge: node({ status: "unavailable", reason: "node_unreachable" }), hosted, userMessage: HAHN }).create({ requestId: uuid(2) });
  assert.equal(nodeDown.status, "ready");
  const noNode = genesisBridge({}, { owner: true });
  const backend = projectBackend({ bridge: noNode, hosted, userMessage: HAHN });
  const built = await backend.create({ requestId: uuid(3) });
  assert.equal(built.status, "ready");
  assert.equal((await backend.status(built.operationId)).status, "ready");
  assert.equal((await backend.status(`gen_${uuid(42)}`)).status, "not-found");
  const app = await projectBackend({ bridge: noNode, hosted, userMessage: "Build a REST API for inventory items" }).create({ requestId: uuid(4) });
  assert.equal(app.status, "unavailable");
  assert.equal(app.reason, "execution_node_not_configured");
  assert.match(app.nextStep, /ATLAS_GENESIS_URL/u);
  // No workspace and no node: still the node's reason and fix.
  const nothing = await projectBackend({ bridge: noNode, hosted: null, userMessage: HAHN }).create({ requestId: uuid(5) });
  assert.equal(nothing.reason, "execution_node_not_configured");
  assert.equal((await projectBackend({ bridge: noNode, hosted: null }).status(`gen_${uuid(6)}`)).status, "not-found");
});

test("the chat tool builds the Team Hahn site end to end and reports it truthfully", async () => {
  const { store } = harness();
  const backend = projectBackend({ bridge: genesisBridge({}, { owner: false }), hosted: { store, scope }, userMessage: HAHN });
  const tools = createProjectTools({ create: backend.create, status: backend.status, requestId: uuid(9), userMessage: HAHN });
  const events = [];
  const outcome = await tools.handlers.workspace_create_project({ function: { arguments: JSON.stringify({ name: "team-hahn-construction", description: HAHN, template: "static-site" }) } }, { emit: (type, data) => events.push([type, data]) });
  assert.equal(outcome.ok, true);
  const result = JSON.parse(outcome.content);
  assert.equal(result.status, "ready");
  assert.equal(result.name, "Team Hahn Construction");
  assert.deepEqual(result.pages.map((page) => page.title), ["Home", "Services", "About", "Gallery", "Contact"]);
  assert.equal(events[0][0], "project");
  const status = await tools.handlers.workspace_project_status({ function: { arguments: JSON.stringify({ operationId: result.operationId }) } });
  assert.equal(JSON.parse(status.content).previewUrl, result.previewUrl);
  assert.ok(PREVIEW_ID.test(result.operationId));
});
