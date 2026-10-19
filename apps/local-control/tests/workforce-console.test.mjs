import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { createLocalControlServer } from "../src/server.mjs";
import { LocalTaskStore } from "../src/store.mjs";
import { PlatformTaskStore } from "../src/platform/task-store.mjs";
import { createWorkforceRuntime } from "../src/platform/workforce-runtime.mjs";

const token = "console-owner-token-32-characters-long";
const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };

async function harness(t) {
  const directory = mkdtempSync(join(tmpdir(), "atlas-workforce-console-"));
  writeFileSync(join(directory, "README.md"), "Console evidence");
  let store, platformStore, runtime, server, origin;
  async function open() {
    store = new LocalTaskStore(join(directory, "local.sqlite"));
    platformStore = new PlatformTaskStore(join(directory, "platform.sqlite"));
    runtime = createWorkforceRuntime({ store: platformStore, dataDirectory: directory, repository: directory,
      model: "fixture", endpoint: "http://127.0.0.1:11434/v1" });
    server = createLocalControlServer({ store, platformStore, token, workforceRuntime: runtime, runTask: async () => ({}) });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${server.address().port}`;
  }
  async function close() {
    await new Promise(resolve => server.close(resolve));
    runtime.close(); platformStore.close(); store.close();
  }
  await open();
  t.after(async () => { await close(); rmSync(directory, { recursive: true, force: true }); });
  return { get runtime() { return runtime; }, get store() { return store; }, get origin() { return origin; },
    request: (path, options = {}) => fetch(`${origin}${path}`, options),
    restart: async () => { await close(); await open(); },
    plan: () => ({ ownerAgentId: runtime.workforce.rootId, reviewerAgentId: runtime.workforce.agents["Quality Reviewer"],
      objective: "Read README with reviewed evidence", constraints: { privacy: "local_only" }, budget: { toolCalls: 2, wallTimeMs: 30_000 },
      steps: [{ agentId: runtime.workforce.agents["Engineering Worker"], calls: [{ tool: "repository.read", input: { path: "README.md" }, outputSchema: { type: "string", minLength: 1 } }] }] }),
  };
}

test("workforce console carries no private data and uses the daemon CSP", async t => {
  const h = await harness(t);
  const response = await h.request("/workforce");
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /Atlas Workforce/);
  assert.match(html, /src="\/workforce.js"/);
  assert.doesNotMatch(html, /<script(?![^>]*\ssrc=)|<style|\sstyle=|\son[a-z]+=/u);
  assert.doesNotMatch(html, /Console evidence|console-owner-token/);
  assert.match(response.headers.get("content-security-policy"), /script-src 'self'/);
  assert.equal((await h.request("/workforce.js")).status, 200);
  assert.equal((await h.request("/v1/workforce/runs")).status, 401);
  const paired = "paired-console-token";
  h.store.addDevice("Phone", createHash("sha256").update(paired).digest("hex"));
  const rejected = await h.request("/v1/workforce/runs", { headers: { authorization: `Bearer ${paired}` } });
  assert.equal(rejected.status, 403);
  assert.doesNotMatch(await rejected.text(), /Read README|Console evidence/);
});

test("run list persists across restart, scopes tenant and omits prompt/tool payloads", async t => {
  const h = await harness(t);
  const intake = await h.request("/v1/workforce/runs", { method: "POST", headers, body: JSON.stringify(h.plan()) });
  assert.equal(intake.status, 202);
  const { taskId } = await intake.json();
  // Existing resume operation shares the active execution, so no polling delays.
  const completed = await h.runtime.coordinator.resume("local", taskId);
  assert.equal(completed.status, "completed");
  h.runtime.registry.db.prepare("INSERT INTO workforce_runs VALUES (?,?,?)").run("other", "hidden-run", JSON.stringify({ taskId: "hidden-run", objective: "OTHER TENANT SECRET" }));
  const response = await h.request("/v1/workforce/runs?limit=1", { headers });
  assert.equal(response.status, 200);
  const { runs } = await response.json();
  assert.equal(runs.length, 1);
  assert.equal(runs[0].taskId, taskId);
  assert.equal(runs[0].status, "completed");
  assert.equal(runs[0].completedSteps, 1);
  assert.doesNotMatch(JSON.stringify(runs), /modelProfile|outputSchema|Console evidence|OTHER TENANT SECRET/);
  assert.equal(h.runtime.coordinator.list("local", { limit: 0 }).length, 1);
  await h.restart();
  const after = await (await h.request("/v1/workforce/runs", { headers })).json();
  assert.equal(after.runs[0].taskId, taskId);
  assert.equal(after.runs[0].status, "completed");
  assert.equal(h.runtime.coordinator.list("other")[0].taskId, "hidden-run");
});

let playwright;
try {
  if (process.env.ATLAS_TEST_PLAYWRIGHT) playwright = await import(pathToFileURL(process.env.ATLAS_TEST_PLAYWRIGHT).href);
} catch { /* The ordinary dependency-free suite uses the real HTTP checks above. */ }

test("persisted run summaries enforce their bound and omit full snapshots", async t => {
  const h = await harness(t);
  const insert = h.runtime.registry.db.prepare("INSERT INTO workforce_runs VALUES (?,?,?)");
  for (let index = 0; index < 120; index++) insert.run("local", `list-${index}`, JSON.stringify({
    taskId: `list-${index}`, status: "interrupted", objective: "x".repeat(1000),
    steps: [{ calls: [{ input: { prompt: "PRIVATE PROMPT" } }], artifacts: ["artifact"], memoryIds: [] }],
  }));
  const summaries = h.runtime.coordinator.list("local", { limit: 10000 });
  assert.equal(summaries.length, 100);
  assert.equal(summaries[0].taskId, "list-119");
  assert.equal(summaries[0].objective.length, 500);
  assert.equal(h.runtime.coordinator.list("local", { limit: NaN }).length, 50);
  assert.equal(h.runtime.coordinator.list("local", { limit: -1 }).length, 1);
  assert.doesNotMatch(JSON.stringify(summaries), /PRIVATE PROMPT|calls/);
});

test("owner console executes and resumes an explicit plan without storing its token", {
  skip: !playwright && "Configure ATLAS_TEST_PLAYWRIGHT for real-browser acceptance", timeout: 120_000,
}, async t => {
  const h = await harness(t);
  const browser = await playwright.chromium.launch({ headless: true,
    ...(process.env.ATLAS_TEST_BROWSER ? { executablePath: process.env.ATLAS_TEST_BROWSER } : {}) });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  const unlock = async () => {
    await page.getByLabel("Owner token", { exact: true }).fill(token);
    await page.getByRole("button", { name: "Unlock workforce", exact: true }).click();
    await page.getByLabel("Plan JSON", { exact: true }).waitFor();
    await page.waitForFunction(() => document.getElementById('plan').value.includes('README.md'));
  };
  await page.goto(`${h.origin}/workforce`);
  await unlock();
  const plan = JSON.parse(await page.getByLabel("Plan JSON").inputValue());
  plan.objective = '<img src=x onerror="window.bad=true">';
  await page.getByLabel("Plan JSON").fill(JSON.stringify(plan));
  let loseReceipt = true;
  await page.route('**/v1/workforce/runs', async route => {
    if (route.request().method() === 'POST' && loseReceipt) {
      loseReceipt = false;
      await route.fulfill({ status: 202, contentType: 'application/json', body: '{}' });
    } else await route.continue();
  });
  await page.getByRole("button", { name: "Run plan", exact: true }).click();
  await page.waitForFunction(() => document.getElementById('notice').textContent.includes('could not be confirmed'));
  assert.equal(await page.getByRole("button", { name: "Run plan", exact: true }).isDisabled(), true);
  await page.waitForResponse(response => response.url().endsWith('/v1/workforce/runs') && response.request().method() === 'GET');
  assert.equal(await page.getByRole("button", { name: "Run plan", exact: true }).isDisabled(), true, 'background refresh never authorizes retry');
  await page.getByRole("button", { name: "Refresh runs", exact: true }).click();
  await page.waitForFunction(() => !document.getElementById('submit').disabled);
  await page.getByRole("button", { name: "Run plan", exact: true }).click();
  await page.waitForFunction(() => document.getElementById('status').textContent.includes('completed'));
  assert.equal(h.runtime.coordinator.list("local").length, 1);
  assert.equal(await page.locator('img').count(), 0);
  assert.equal(await page.evaluate(() => window.bad), undefined);
  assert.equal(await page.getByLabel("Owner token").inputValue(), "");
  assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  assert.equal(await page.getByRole("link", { name: "Open task evidence" }).getAttribute('href'), '/platform');
  await page.getByRole("button", { name: "Lock", exact: true }).click();
  assert.equal(await page.locator('#workspace').isVisible(), false);
  const pending = h.runtime.coordinator.create({ ...h.plan(), tenantId: "local", userId: "owner", objective: "Restart acceptance" });
  await h.restart();
  await page.goto(`${h.origin}/workforce`);
  await unlock();
  await page.getByRole("button", { name: /Restart acceptance.*interrupted/ }).click();
  await page.getByRole("button", { name: "Resume interrupted run", exact: true }).click();
  await page.waitForFunction(() => document.getElementById('status').textContent.includes('completed'));
  assert.equal(h.runtime.coordinator.get("local", pending.taskId).status, "completed");
  assert.deepEqual(errors, []);
});
