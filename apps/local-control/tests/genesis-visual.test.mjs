import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { GenesisService, GenesisStore } from "../src/platform/genesis/index.mjs";
import { GenesisExecutor } from "../src/platform/genesis/executor.mjs";
import { PreviewManager } from "../src/platform/genesis/preview.mjs";
import { createInspector, inspectOverHttp, loadPlaywright } from "../src/platform/genesis/inspector.mjs";
import { runCheck } from "../src/platform/self-improve/runtime.mjs";
import { LocalTaskStore } from "../src/store.mjs";
import { createLocalControlServer } from "../src/server.mjs";

const TOKEN = "visual-editor-owner-test-token-0123456789";
async function fixture(run) {
  const root = mkdtempSync(join(tmpdir(), "atlas-visual-"));
  const store = new GenesisStore(join(root, "genesis.sqlite"));
  const tasks = new LocalTaskStore(join(root, "tasks.sqlite"));
  let executor;
  const genesis = new GenesisService({ store, onChange: (p) => { if (p.state === "approved" && executor) executor.run(p.id); } });
  const previews = new PreviewManager({ registryPath: join(root, "previews.json"), runPrepare: runCheck });
  executor = new GenesisExecutor({ genesis, projectsRoot: join(root, "projects"), runCheck, preview: previews, inspector: createInspector({ artifactsRoot: join(root, "inspection") }) });
  const server = createLocalControlServer({ store: tasks, token: TOKEN, runTask: async () => ({}), genesis, genesisPreviews: previews });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const created = await genesis.create("Build a website for my roofing company");
  const project = await executor.run(created.id);
  const request = (body, token = TOKEN) => fetch(`${origin}/v1/genesis/${project.id}/visual`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  try {
    assert.equal(project.state, "ready", JSON.stringify(project.transitions.at(-1)));
    await run({ root, store, tasks, genesis, executor, previews, project, origin, request });
  } finally {
    await Promise.all([...executor.running.values()]);
    await previews.stopAll();
    await new Promise((done) => { server.close(done); server.closeAllConnections(); });
    store.close(); tasks.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

test("visual HTTP boundary: source selection, scoped edit, rebuild, validation and preview; rejects stale/forged input", () => fixture(async ({ project, tasks, genesis, executor, request, origin }) => {
  assert.equal((await request({ action: "open", parentOrigin: origin }, "wrong")).status, 401);
  tasks.addDevice("Read-only phone", createHash("sha256").update("device-token").digest("hex"));
  assert.equal((await request({ action: "open", parentOrigin: origin }, "device-token")).status, 403);
  assert.equal((await request({ action: "open", parentOrigin: "https://evil.example" })).status, 409);
  const { design } = await (await request({ action: "open", parentOrigin: origin })).json();
  assert.notEqual(new URL(design.url).origin, origin);
  const html = await fetch(design.url);
  assert.match(html.headers.get("content-security-policy"), /default-src 'none'/u);
  const markup = await html.text();
  assert.match(markup, /data-atlas-source="home:headline"/u);
  assert.ok(!markup.includes(TOKEN));
  for (const path of ["/site.json", "/v1/genesis", "/..%5csite.json", "/%2e%2e%2fsite.json"]) assert.equal((await fetch(design.url + path)).status, 404);
  assert.equal((await fetch(design.url, { method: "POST" })).status, 405);
  assert.equal((await request({ action: "select", key: "../../secret:headline" })).status, 409);
  // Preserve hand-edited content outside the selected field.
  const file = join(project.workspace, "site.json");
  const site = JSON.parse(readFileSync(file, "utf8")); site.tagline = "Keep this manually edited tagline";
  writeFileSync(file, JSON.stringify(site, null, 2));
  const { selection } = await (await request({ action: "select", key: "home:headline" })).json();
  assert.equal(selection.file, "site.json"); assert.equal(selection.pointer, "/pages/0/headline");
  assert.equal((await request({ action: "edit", ...selection, digest: "forged", text: "No" })).status, 409);
  assert.equal((await request({ action: "edit", ...selection, text: " " })).status, 409);
  const text = "Reliable roofing <with care>";
  assert.equal((await request({ action: "edit", ...selection, text })).status, 200);
  const done = await executor.run(project.id);
  assert.equal(done.state, "ready", JSON.stringify(done.transitions.at(-1)));
  assert.equal(JSON.parse(readFileSync(file)).pages[0].headline, text);
  assert.equal(JSON.parse(readFileSync(file)).tagline, site.tagline);
  assert.match(await (await fetch(done.preview.url)).text(), /Reliable roofing &lt;with care&gt;/u);
  assert.equal((await inspectOverHttp(done, done.preview)).ok, true, "HTTP-only verification also accepts source attributes and escaped text");
  const evidence = done.transitions.findLast((t) => t.to === "previewing").evidence;
  assert.deepEqual(evidence.results.map((r) => [r.name, r.exitCode]), [["check", 0], ["test", 0], ["build", 0]]);
  assert.equal((await request({ action: "edit", ...selection, text: "stale" })).status, 409);
  assert.ok(genesis.view(project.id).transitions.some((t) => t.evidence.kind === "visual-edit"));
  // Respect plan approval and refuse a file changed after approval was requested.
  genesis.policy = () => ({ decision: "ask" });
  let modelCalls = 0;
  genesis.intelligence.refinePlan = async () => { modelCalls += 1; throw new Error("Model must not be used for this edit"); };
  const next = (await (await request({ action: "select", key: "home:intro" })).json()).selection;
  assert.equal((await request({ action: "edit", ...next, text: "Queued introduction" })).status, 200);
  assert.equal(genesis.view(project.id).state, "planned");
  assert.equal(modelCalls, 0);
  const external = JSON.parse(readFileSync(file)); external.tagline = "Changed while awaiting approval";
  writeFileSync(file, JSON.stringify(external));
  genesis.approve(project.id);
  const blocked = await executor.run(project.id);
  assert.equal(blocked.state, "failed");
  assert.match(blocked.transitions.at(-1).reason, /Source changed/u);
  assert.equal(JSON.parse(readFileSync(file)).pages[0].intro, next.text);
}));

test("browser boundary: Build UI picker -> source -> apply -> verified rebuilt application", async (t) => {
  const playwright = await loadPlaywright();
  if (!playwright) { assert.notEqual(process.env.GENESIS_REQUIRE_FULL, "1", "browser dependency required in Genesis CI"); t.skip("Playwright unavailable"); return; }
  let browser;
  try { browser = await playwright.chromium.launch({ headless: true }); }
  catch (error) { if (process.env.GENESIS_REQUIRE_FULL === "1") throw error; t.skip("Chromium unavailable"); return; }
  try {
    await fixture(async ({ origin, project, executor, genesis }) => {
      const page = await browser.newPage();
      await page.addInitScript(({ token, origin: parent }) => { if (location.origin === parent) sessionStorage.setItem("atlas-token", token); }, { token: TOKEN, origin });
      await page.goto(`${origin}/#/build/${project.id}`);
      await page.locator("#visual-open").click();
      const frame = page.frameLocator("#visual-frame");
      await frame.locator('[data-atlas-source="home:headline"]').click();
      assert.equal(await frame.locator("body").evaluate(() => sessionStorage.getItem("atlas-token")), null, "preview origin never receives the owner credential");
      await page.waitForFunction(() => document.querySelector("#visual-source")?.textContent.includes("/pages/0/headline"));
      const before = await page.locator("#visual-text").inputValue();
      await page.evaluate(() => window.postMessage({ type: "atlas:visual-selection", key: "home:intro", session: "forged" }, location.origin));
      assert.equal(await page.locator("#visual-text").inputValue(), before);
      await page.locator("#visual-text").fill("Roofing you can count on");
      const response = page.waitForResponse((r) => r.url().endsWith("/visual") && r.request().postDataJSON().action === "edit");
      await page.locator("#visual-save").click();
      assert.equal((await response).status(), 200);
      const done = await executor.run(project.id);
      assert.equal(done.state, "ready", JSON.stringify(done.transitions.at(-1)));
      await page.goto(done.preview.url);
      assert.equal(await page.locator("h1").innerText(), "Roofing you can count on");
      assert.equal(genesis.view(project.id).transitions.at(-1).evidence.summary.inspection.limited, false);
      await page.close();
    });
  } finally { await browser.close(); }
});
