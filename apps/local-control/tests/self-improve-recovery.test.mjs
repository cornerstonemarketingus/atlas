import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SelfImprovementLoop } from "../src/platform/self-improve/loop.mjs";
import { resolveCheck, runCheck, assertSafeEndpoint } from "../src/platform/self-improve/runtime.mjs";
import { SelfImprovementService, createSelfImproveRoutes } from "../src/platform/self-improve/service.mjs";

function sh(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), "atlas-selfsvc-"));
  const repository = join(root, "repo");
  mkdirSync(join(repository, "src"), { recursive: true });
  mkdirSync(join(repository, "tests"), { recursive: true });
  writeFileSync(join(repository, "package.json"), JSON.stringify({ name: "fixture", type: "module" }));
  writeFileSync(join(repository, "src", "math.mjs"), "export function add(a, b) { return a - b; }\n");
  writeFileSync(join(repository, "tests", "math.test.mjs"), "import assert from 'node:assert/strict';\nimport test from 'node:test';\nimport { add } from '../src/math.mjs';\ntest('adds', () => assert.equal(add(2, 3), 5));\n");
  sh(repository, "init", "-q", "-b", "main");
  sh(repository, "-c", "user.name=t", "-c", "user.email=t@t", "add", "-A");
  sh(repository, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
  let builds = 0, checks = 0;
  const options = {
    repository,
    decisionsPath: join(root, "decisions.jsonl"),
    createLoop: ({ log, onOutput }) => new SelfImprovementLoop({
      repository, worktreeRoot: join(root, "worktrees"), ledgerPath: join(root, "ledger.jsonl"), patchesDirectory: join(root, "patches"),
      runCheck: (...args) => { checks++; return runCheck(...args); }, log,
      builder: async ({ worktree }) => { builds++; onOutput("coder: fixing add()\n"); writeFileSync(join(worktree, "src", "math.mjs"), "export function add(a, b) { return a + b; }\n"); return { ok: true }; },
      reviewer: async () => ({ approve: true, summary: "Correct.", concerns: [] }),
    }),
  };
  return { root, repository, service: new SelfImprovementService(options), restart: () => new SelfImprovementService(options), counts: () => ({ builds, checks }) };
}


test("unavailable review survives restart; owner retry rechecks without rebuilding or merging", async t => {
  const f = setup(); t.after(() => rmSync(f.root, { recursive: true, force: true }));
  f.service.loop.options.reviewer = async () => { throw new Error("429 SECRET_SENTINEL"); };
  const [result] = await f.service.start().promise;
  assert.equal(result.outcome, "awaiting_review");
  assert.equal(f.service.pending().length, 0);
  const before = f.counts();
  assert.ok(!JSON.stringify(f.service.status()).includes("SECRET_SENTINEL"));
  const service = f.restart();
  assert.equal(service.status().recoverable.length, 1);
  const sent = [];
  const route = createSelfImproveRoutes({ service, parseBody: async () => ({}), send: (_, status, value) => sent.push({ status, value }) });
  const request = { method: "POST", url: `/v1/self-improve/recoveries/${result.id}/retry` };
  await route(request, {}, { role: "device" });
  assert.equal(sent.at(-1).status, 403);
  await route(request, {}, { role: "admin" });
  assert.equal(sent.at(-1).status, 202);
  await service.current.promise;
  assert.equal(service.pending().length, 1);
  assert.equal(service.status().recoverable.length, 0);
  assert.equal(f.counts().builds, before.builds);
  assert.ok(f.counts().checks > before.checks);
  assert.match(readFileSync(join(f.repository, "src/math.mjs"), "utf8"), /a - b/u);
  assert.ok(readFileSync(service.pending()[0].patch, "utf8").includes("a + b"));
  await route(request, {}, { role: "admin" });
  assert.equal(sent.at(-1).status, 404);
});

test("changed candidate refuses recovery; explicit discard requires unchanged identity", async t => {
  const f = setup(); t.after(() => rmSync(f.root, { recursive: true, force: true }));
  f.service.loop.options.reviewer = async () => { throw new Error("offline"); };
  const [result] = await f.service.start().promise;
  const path = join(f.root, "worktrees", result.id, "builder");
  writeFileSync(join(path, "notes.txt"), "owner work");
  await assert.rejects(f.service.loop.retryReview(result.id), /changed files/u);
  await assert.rejects(f.service.loop.discardRecovery(result.id), /changed files/u);
  rmSync(join(path, "notes.txt"));
  sh(path, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "--allow-empty", "-qm", "different head");
  await assert.rejects(f.service.loop.retryReview(result.id), /missing or changed/u);
  sh(path, "reset", "--hard", result.head);
  await f.service.discardRecovery(result.id);
  assert.equal(f.service.status().recoverable.length, 0);
  assert.equal(sh(f.repository, "branch", "--list", result.branch), "");
  assert.equal(f.service.loop.history().at(-1).outcome, "discarded");
});

test("retry enforces current checks and policy, then honors independent rejection", async t => {
  const f = setup(); t.after(() => rmSync(f.root, { recursive: true, force: true }));
  const loop = f.service.loop;
  loop.options.reviewer = async () => { throw new Error("offline"); };
  const [result] = await f.service.start().promise;
  let reviews = 0;
  loop.options.reviewer = async () => { reviews++; return { approve: false, summary: "Reject", concerns: [] }; };
  const originalCheck = loop.options.runCheck;
  loop.options.runCheck = async () => ({ exitCode: 1, stdout: "failed" });
  assert.equal((await loop.retryReview(result.id)).outcome, "awaiting_review");
  assert.equal(reviews, 0);
  loop.options.runCheck = originalCheck;
  loop.options.limits = { maxFiles: 0 };
  assert.equal((await loop.retryReview(result.id)).outcome, "awaiting_review");
  assert.equal(reviews, 0);
  loop.options.limits = {};
  assert.equal((await loop.retryReview(result.id)).outcome, "rejected");
  assert.equal(reviews, 1);
  assert.equal(loop.recoveries().length, 0);
  assert.equal(sh(f.repository, "branch", "--list", result.branch), "");
});

import { ReviewRecovery } from '../src/platform/self-improve/recovery.mjs';
import { createLocalControlServer } from '../src/server.mjs';
import { LocalTaskStore } from '../src/store.mjs';

test('exclusive recovery lease survives process exit and is reclaimed only when its owner is dead', t => {
  const root = mkdtempSync(join(tmpdir(), 'atlas-recovery-lease-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const id = 'self-20260930000000-test';
  const store = new ReviewRecovery(root);
  const release = store.lock(id);
  assert.throws(() => new ReviewRecovery(root).lock(id), /Another run owns/u);
  release();
  const module = new URL('../src/platform/self-improve/recovery.mjs', import.meta.url).href;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `import {ReviewRecovery} from ${JSON.stringify(module)}; new ReviewRecovery(process.argv[1]).lock(process.argv[2]);`, root, id], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  store.lock(id)();
});

test('Command Center offers an authenticated working recovery action; device cannot retry or discard', async t => {
  const f = setup();
  f.service.loop.options.reviewer = async () => { throw new Error('offline'); };
  const [result] = await f.service.start().promise;
  const service = f.restart();
  const token = '0123456789abcdef0123456789abcdef';
  const store = new LocalTaskStore(join(f.root, 'tasks.sqlite'));
  const server = createLocalControlServer({ store, token, runTask: async () => ({ ok: true }), selfImprove: service });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await service.current?.promise; await new Promise(resolve => server.close(resolve)); store.close(); rmSync(f.root, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const admin = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const call = async (path, init = {}) => { const r = await fetch(origin + path, init); return { status: r.status, body: await r.json() }; };
  const item = (await call('/v1/command-center', { headers: admin })).body.items.find(i => i.id === `recovery-${result.id}`);
  assert.equal(item.bucket, 'attention');
  const action = item.actions[0];
  assert.equal((await call(action.path, { method: 'POST' })).status, 401);
  const { code } = (await call('/v1/pair', { method: 'POST', headers: admin })).body;
  const { deviceToken } = (await call('/v1/pair/claim', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, name: 'Phone' }) })).body;
  const device = { authorization: `Bearer ${deviceToken}`, 'content-type': 'application/json' };
  for (const verb of ['retry', 'discard']) assert.equal((await call(`/v1/self-improve/recoveries/${result.id}/${verb}`, { method: 'POST', headers: device, body: '{}' })).status, 403);
  assert.equal((await call(action.path, { method: action.method, headers: admin, body: JSON.stringify(action.body) })).status, 202);
  await service.current?.promise;
  const items = (await call('/v1/command-center', { headers: admin })).body.items;
  assert.ok(!items.some(i => i.id === item.id));
  assert.ok(items.some(i => i.state === 'awaiting_approval'));
  assert.match(readFileSync(join(f.repository, 'src/math.mjs'), 'utf8'), /a - b/u);
});

test('Improve Atlas UI exposes retained work and retries through the real daemon', async t => {
  const { loadPlaywright } = await import('../src/platform/genesis/inspector.mjs');
  const engine = await loadPlaywright();
  if (!engine) { t.skip('Playwright not installed'); return; }
  let browser;
  try { browser = await engine.chromium.launch({ headless: true }); }
  catch (error) { if (error.message.includes("Executable doesn't exist")) { t.skip('Chromium not installed'); return; } throw error; }
  const f = setup();
  f.service.loop.options.reviewer = async () => { throw new Error('offline'); };
  const [result] = await f.service.start().promise;
  const service = f.restart();
  const token = '0123456789abcdef0123456789abcdef';
  const store = new LocalTaskStore(join(f.root, 'tasks.sqlite'));
  const server = createLocalControlServer({ store, token, runTask: async () => ({ ok: true }), selfImprove: service });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await browser.close(); await service.current?.promise; await new Promise(resolve => server.close(resolve)); store.close(); rmSync(f.root, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const page = await browser.newPage();
  await page.addInitScript(({ origin, token }) => { if (location.origin === origin) sessionStorage.setItem('atlas-token', token); }, { origin, token });
  await page.goto(origin + '/#/improve');
  await page.locator(`[data-recovery="retry"][data-id="${result.id}"]`).click();
  await page.locator(`[data-improve="approve"][data-id="${result.id}"]`).waitFor({ timeout: 30000 });
  assert.equal(await page.locator('[data-recovery="retry"]').count(), 0);
  assert.match(readFileSync(join(f.repository, 'src/math.mjs'), 'utf8'), /a - b/u);
});
