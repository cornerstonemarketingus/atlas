import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { GenesisService, GenesisStore } from "../src/platform/genesis/index.mjs";
import { GenesisExecutor } from "../src/platform/genesis/executor.mjs";
import { loadPlaywright } from "../src/platform/genesis/inspector.mjs";
import { PreviewManager } from "../src/platform/genesis/preview.mjs";
import { runCheck } from "../src/platform/self-improve/runtime.mjs";

// The generated web app must show the screen the person is on, whatever order
// the network answers in. CI's Genesis inspection failed intermittently on
// exactly this: a slow record response replaced the list it had moved to.

const required = process.env.GENESIS_REQUIRE_FULL === "1";
const playwright = await loadPlaywright();
const skip = required ? false : await (async () => {
  if (!playwright) return "Playwright is not installed (the Genesis CI job installs it)";
  try { const browser = await playwright.chromium.launch({ headless: true }); await browser.close(); return false; } catch { return "Chromium is not installed"; }
})();

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function withLeadTracker(run) {
  const root = mkdtempSync(join(tmpdir(), "atlas-genesis-races-"));
  const store = new GenesisStore(join(root, "genesis.sqlite"));
  const genesis = new GenesisService({ store, policy: () => ({ decision: "allow" }) });
  const preview = new PreviewManager({ registryPath: join(root, "previews.json"), runPrepare: runCheck });
  // No inspector: this test drives the browser itself.
  const executor = new GenesisExecutor({ genesis, projectsRoot: join(root, "projects"), runCheck, coder: null, preview, inspector: async () => ({ ok: true, findings: [], limited: false, evidence: { mode: "browser", checks: [] } }) });
  const browser = await playwright.chromium.launch({ headless: true });
  try {
    const project = await genesis.create("Build a simple customer lead tracker with: add customer, name/email/phone, status, notes, dashboard, search");
    const done = await executor.run(project.id);
    assert.equal(done.state, "ready", JSON.stringify(done.transitions.at(-1)));
    const add = async (name) => (await (await fetch(`${done.preview.url}/api/customers`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, email: `${name.toLowerCase()}@example.com`, status: "New" }) })).json()).record;
    await run({ url: done.preview.url, page: await browser.newPage(), add });
  } finally {
    await browser.close();
    await preview.stopAll();
    store.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

test("a slow response from the screen just left never replaces the current one", { skip, timeout: 300_000 }, () => withLeadTracker(async ({ url, page, add }) => {
  const ada = await add("Ada");
  await add("Grace");
  // The record screen's request answers only after the person has moved on.
  await page.route(/\/api\/customers\/\d+$/u, async (route) => { await delay(1_500); await route.continue(); });
  const recordRequested = page.waitForRequest(/\/api\/customers\/\d+$/u);
  await page.goto(`${url}/#/customers/${ada.id}`, { waitUntil: "load" });
  await recordRequested;
  await page.goto(`${url}/#/customers`, { waitUntil: "load" });
  await page.locator("table tbody tr").first().waitFor();
  await delay(2_000);
  assert.equal(await page.locator("h1").textContent(), "Customers", "the list stays on screen");
  assert.equal(await page.locator("#search").count(), 1);
  assert.equal(await page.locator("table tbody tr").count(), 2);
}));

test("only the newest search's answer is shown", { skip, timeout: 300_000 }, () => withLeadTracker(async ({ url, page, add }) => {
  await add("Ada");
  await add("Grace");
  // The unfiltered first load is slow; the search typed meanwhile is fast.
  await page.route(/\/api\/customers\?q=$/u, async (route) => { await delay(1_500); await route.continue(); });
  await page.goto(`${url}/#/customers`, { waitUntil: "load" });
  await page.locator("#search").fill("grace");
  await page.locator("table tbody tr").filter({ hasText: "Grace" }).first().waitFor();
  await delay(2_000);
  assert.equal(await page.locator("table tbody tr").count(), 1, "the late unfiltered answer does not replace the search result");
}));
