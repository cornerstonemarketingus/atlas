import assert from 'node:assert/strict';
import test from 'node:test';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
let playwright;
try { playwright = await import(process.env.ATLAS_TEST_PLAYWRIGHT ? pathToFileURL(process.env.ATLAS_TEST_PLAYWRIGHT).href : 'playwright-core'); }
catch { /* Browser acceptance is optional without a configured runtime. */ }

const id = 'gen_11111111-1111-4111-8111-111111111111';
const shots = process.env.ATLAS_SCREENSHOT_DIR;

async function serve(t, component, file) {
  const { createServer } = await import('vite'); const { default: react } = await import('@vitejs/plugin-react');
  const html = `<html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app/workspace.css"><link rel="stylesheet" href="/app/atlas-shell.css"></head><body style="background:#0b0d0c;color:#f3f5f1;font-family:system-ui;padding:16px"><div id="root"></div><script type="module">import React from "react";import{createRoot}from"react-dom/client";import{${component}}from"${file}";createRoot(document.getElementById("root")).render(React.createElement(${component}));</script></body></html>`;
  const server = await createServer({ root: fileURLToPath(new URL('../', import.meta.url)), configFile: false, cacheDir: '../../.setup-health-sites-cache', plugins: [{
    name: 'health-sites-fixture', enforce: 'pre',
    resolveId(source, importer) { if (source === 'next/link') return '\0link'; if (source === '../AtlasShell.js' && importer?.includes('SetupCenter')) return '\0shell'; },
    load(source) { if (source === '\0link') return 'import React from "react";export default function Link(props){return React.createElement("a",props)}'; if (source === '\0shell') return 'import React from "react";export function AtlasShell({children,headerContext}){return React.createElement("main",null,headerContext,children)}'; },
    configureServer(vite) { vite.middlewares.use((req, res, next) => { if (req.url !== '/') return next(); void vite.transformIndexHtml('/', html).then(body => { res.setHeader('Content-Type', 'text/html'); res.end(body); }); }); },
  }, react()], resolve: { dedupe: ['react', 'react-dom'] }, server: { host: '127.0.0.1', port: 0 } });
  await server.listen(); t.after(() => server.close());
  const browser = await playwright.chromium.launch({ headless: true, ...(process.env.ATLAS_TEST_BROWSER ? { executablePath: process.env.ATLAS_TEST_BROWSER } : {}) }); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  return { page, url: server.resolvedUrls.local[0], errors };
}

test('owner Connections shows chat route, quota and an on-demand provider check without secrets', { skip: !playwright && 'Configure Playwright', timeout: 90000 }, async t => {
  const { page, url, errors } = await serve(t, 'SetupCenter', '/app/setup/SetupCenter.tsx');
  let providerCalls = 0; let providerStatus = 200;
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/setup/status') return route.fulfill({ json: { audience: 'owner', overall: 'ready', completedSteps: 1, totalSteps: 1, steps: [{ id: 'd1', label: 'Database', state: 'complete', detail: 'Ready.' }],
      optional: { stripeConfigured: false, chat: { configured: true, fallbackModelConfigured: true, modelPoolSize: 2, webSearchConfigured: false, route: ['groq', 'workers-ai'] },
        inferenceGovernor: { bound: true, reachable: true, models: 2, reservations: 0, waiting: 1, limitedModels: 1, accountPause: null } } } });
    if (path === '/api/setup/providers') {
      providerCalls++;
      if (providerStatus !== 200) return route.fulfill({ status: providerStatus, json: { message: 'PRIVATE detail' } });
      return route.fulfill({ json: { version: 1, route: ['groq'], providers: { workersAI: { category: 'PROVIDER_RATE_LIMIT', recommendedAction: 'PRIVATE ATLAS_WORKERS_AI_TOKEN' }, workersAIBinding: { category: 'OK', model: 'PRIVATE_MODEL' } } } });
    }
    if (path === '/api/chat') return route.fulfill({ json: { configured: true, reason: null } });
    if (path === '/api/github/status') return route.fulfill({ json: { connected: true, method: 'app', installUrl: null } });
    return route.fulfill({ json: { repositories: [] } });
  });
  await page.goto(url);
  const health = page.getByRole('heading', { name: /Chat providers and quota/u });
  await health.waitFor();
  assert.match(await health.innerText(), /^02/u);
  await page.getByText('Chat tries Groq, then Cloudflare Workers AI.', { exact: false }).waitFor();
  await page.getByText('1 model is at a limit').waitFor();
  assert.match(await page.getByRole('heading', { name: /Setup checklist/u }).innerText(), /^04/u);
  assert.equal(providerCalls, 0, 'the provider check spends quota, so it never runs on page load');
  const check = page.getByRole('button', { name: 'Check providers' });
  await check.focus(); await page.keyboard.press('Enter');
  await page.getByText('At its limit').waitFor(); await page.getByText('Working', { exact: true }).waitFor();
  assert.equal(providerCalls, 1);
  if (shots) await page.screenshot({ path: join(shots, 'connections-owner-phone.png'), fullPage: true });
  providerStatus = 403; await page.getByRole('button', { name: 'Check providers again' }).click();
  assert.equal(await page.getByRole('alert').innerText(), 'Only the deployment owner can run provider checks.');
  const text = await page.locator('body').innerText();
  assert.doesNotMatch(text, /PRIVATE|ATLAS_|gsk_/u);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'no horizontal scroll at phone width');
  assert.deepEqual(errors, []);
});

test('Your websites lists sites with loading, empty, error and keyboard-reachable preview links', { skip: !playwright && 'Configure Playwright', timeout: 90000 }, async t => {
  const { page, url, errors } = await serve(t, 'HostedSites', '/app/build/HostedSites.tsx');
  let mode = 'list'; let release;
  await page.route('**/api/genesis/projects', async route => {
    if (mode === 'slow') await new Promise(resolve => { release = resolve; });
    if (mode === 'error') return route.fulfill({ status: 503, json: { message: 'PRIVATE backend' } });
    if (mode === 'empty') return route.fulfill({ json: { projects: [] } });
    return route.fulfill({ json: { projects: [
      { id, name: 'Harbor Bakery', status: 'ready', updatedAt: new Date(Date.now() - 2 * 3600_000).toISOString(), previewUrl: `/preview/${id}`, prompt: 'PRIVATE prompt' },
      { id: 'gen_22222222-2222-4222-8222-222222222222', name: 'Plumber landing page', status: 'planned', updatedAt: '2026-10-01T09:00:00.000Z', previewUrl: null },
    ] } });
  });
  await page.goto(url);
  mode = 'slow';
  await page.locator('summary').focus(); await page.keyboard.press('Enter');
  await page.getByText('Loading your websites…').waitFor();
  mode = 'list'; release();
  await page.getByRole('heading', { name: 'Harbor Bakery' }).waitFor();
  const link = page.getByRole('link', { name: 'Open preview of Harbor Bakery (opens in a new tab)' });
  assert.equal(await link.getAttribute('href'), `/preview/${id}`);
  await page.getByText('Updated 2 hours ago').waitFor();
  await page.getByText('No preview yet').waitFor();
  await page.keyboard.press('Tab'); await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('href')), `/preview/${id}`, 'the preview link is reachable by keyboard');
  assert.doesNotMatch(await page.locator('body').innerText(), /PRIVATE/u);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'no horizontal scroll at phone width');
  if (shots) await page.screenshot({ path: join(shots, 'your-websites-phone.png'), fullPage: true });
  mode = 'empty'; await page.getByRole('button', { name: 'Refresh websites' }).click();
  await page.getByText('No websites yet.', { exact: false }).waitFor();
  mode = 'error'; await page.getByRole('button', { name: 'Refresh websites' }).click();
  assert.equal(await page.getByRole('alert').innerText(), 'Your websites could not be loaded. Try again shortly.');
  assert.deepEqual(errors, []);
});
