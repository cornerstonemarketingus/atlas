import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
let playwright;
try { playwright = await import(process.env.ATLAS_TEST_PLAYWRIGHT ? pathToFileURL(process.env.ATLAS_TEST_PLAYWRIGHT).href : 'playwright-core'); }
catch { /* Browser acceptance is optional without a configured runtime. */ }

test('actual Connections view keeps customer status separate from owner diagnostics', { skip: !playwright && 'Configure Playwright', timeout: 60000 }, async t => {
  const { createServer } = await import('vite'); const { default: react } = await import('@vitejs/plugin-react');
  const html = '<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module">import React from "react";import{createRoot}from"react-dom/client";import{SetupCenter}from"/app/setup/SetupCenter.tsx";window.__setupRoot=createRoot(document.getElementById("root"));window.__setupRoot.render(React.createElement(SetupCenter));</script></body></html>';
  const server = await createServer({ root: fileURLToPath(new URL('../', import.meta.url)), configFile: false, cacheDir: '../../.setup-privacy-cache', plugins: [{
    name: 'setup-boundary-fixture', enforce: 'pre',
    resolveId(id, importer) { if (id === 'next/link') return '\0setup-link'; if (id === '../AtlasShell.js' && importer?.includes('SetupCenter')) return '\0setup-shell'; },
    load(id) { if (id === '\0setup-link') return 'import React from "react";export default function Link(props){return React.createElement("a",props)}'; if (id === '\0setup-shell') return 'import React from "react";export function AtlasShell({children,headerContext}){return React.createElement("main",null,headerContext,children)}'; },
    configureServer(vite) { vite.middlewares.use((req, res, next) => { if (req.url !== '/') return next(); void vite.transformIndexHtml('/', html).then(body => { res.setHeader('Content-Type', 'text/html'); res.end(body); }); }); },
  }, react()], resolve: { dedupe: ['react', 'react-dom'] }, server: { host: '127.0.0.1', port: 0 } });
  await server.listen(); t.after(() => server.close());
  const browser = await playwright.chromium.launch({ headless: true, ...(process.env.ATLAS_TEST_BROWSER ? { executablePath: process.env.ATLAS_TEST_BROWSER } : {}) }); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } }); const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    const fetch = window.fetch.bind(window);
    const timeout = window.setTimeout.bind(window);
    // Exercise the real deadline branch without making the fixture wait 12 seconds.
    window.setTimeout = (callback, delay, ...args) => timeout(callback, delay === 12000 && ['headers', 'body', 'late'].includes(window.__setupMode) ? 50 : delay, ...args);
    window.__setupRequests = 0; window.__setupMode = 'normal'; window.__setupPending = []; window.__setupSignals = [];
    window.fetch = (input, options) => {
      if (input === '/api/setup/status') {
        window.__setupRequests++; window.__setupSignals.push(options?.signal);
        if (window.__setupMode === 'headers') return new Promise(() => {});
        if (window.__setupMode === 'body') return Promise.resolve({ status: 200, ok: true, json: () => new Promise(() => {}) });
        if (['late', 'unmount'].includes(window.__setupMode)) return new Promise(resolve => window.__setupPending.push(resolve));
      }
      return fetch(input, options);
    };
  });
  let owner = false; let statusFailure = false; let malformed = false;
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    let body = {};
    if (path === '/api/setup/status') {
      if (statusFailure) return route.fulfill({ status: 503, json: { message: 'PRIVATE_BACKEND /srv/deploy' } });
      if (malformed) return route.fulfill({ json: { steps: null, detail: 'PRIVATE_BACKEND' } });
      body = owner ? { audience: 'owner', overall: 'blocked', completedSteps: 0, totalSteps: 1, steps: [{ id: 'd1', label: 'Database', state: 'failed', detail: 'PRIVATE_D1 diagnostic' }], optional: { stripeConfigured: true } } : { audience: 'customer', overall: 'account-ready', completedSteps: 1, totalSteps: 1, steps: [{ id: 'account', label: 'Account connected', state: 'complete', detail: 'Manage your projects and permissions on this page.' }], optional: {} };
    }
    if (path === '/api/chat') body = { configured: false, reason: 'PRIVATE_MODEL diagnostic' };
    if (path === '/api/github/status') body = { connected: false, method: 'app', installUrl: null };
    if (path === '/api/github/options') body = { repositories: [] };
    return route.fulfill({ json: body });
  });
  await page.goto(server.resolvedUrls.local[0]);
  await page.getByRole('heading', { name: '03Account status' }).waitFor();
  assert.equal(await page.getByText('Account connected', { exact: true }).count(), 2);
  assert.equal(await page.getByRole('heading', { name: 'Stripe billing' }).count(), 0);
  assert.doesNotMatch(await page.locator('body').innerText(), /PRIVATE|credentials|D1 diagnostic/);
  statusFailure = true; await page.getByRole('button', { name: 'Refresh live status' }).click();
  await page.getByRole('alert').waitFor(); assert.doesNotMatch(await page.getByRole('alert').innerText(), /PRIVATE|\/srv/);
  statusFailure = false;
  malformed = true; await page.getByRole('button', { name: 'Refresh live status' }).click();
  await page.waitForFunction(() => !document.querySelector('.page-action').disabled);
  assert.doesNotMatch(await page.getByRole('alert').innerText(), /PRIVATE/);
  malformed = false; await page.getByRole('button', { name: 'Refresh live status' }).click();
  await page.waitForFunction(() => !document.querySelector('.page-action').disabled);
  assert.equal(await page.getByRole('alert').count(), 0);
  for (const mode of ['headers', 'body']) {
    await page.evaluate(mode => { window.__setupMode = mode; }, mode);
    const before = await page.evaluate(() => window.__setupRequests);
    await page.getByRole('button', { name: 'Refresh live status' }).click();
    await page.waitForFunction(() => !document.querySelector('.page-action').disabled);
    await page.getByRole('alert').waitFor();
    assert.equal(await page.evaluate(() => window.__setupRequests), before + 1, 'timeouts never automatically retry');
    await page.evaluate(() => { window.__setupMode = 'normal'; });
    await page.getByRole('button', { name: 'Refresh live status' }).click();
    await page.waitForFunction(() => !document.querySelector('.page-action').disabled);
    assert.equal(await page.getByRole('alert').count(), 0, 'explicit retry recovers');
  }
  await page.evaluate(() => { window.__setupMode = 'late'; });
  await page.getByRole('button', { name: 'Refresh live status' }).click();
  await page.waitForFunction(() => !document.querySelector('.page-action').disabled);
  await page.evaluate(() => { window.__setupMode = 'normal'; });
  await page.getByRole('button', { name: 'Refresh live status' }).click();
  await page.waitForFunction(() => !document.querySelector('.page-action').disabled);
  await page.evaluate(() => window.__setupPending.shift()({ status: 200, ok: true, json: async () => ({ audience: 'owner', overall: 'blocked', completedSteps: 0, totalSteps: 1, steps: [{ id: 'stale', label: 'PRIVATE_STALE', state: 'failed', detail: 'PRIVATE_STALE' }], optional: {} }) }));
  await page.waitForTimeout(100);
  assert.doesNotMatch(await page.locator('body').innerText(), /PRIVATE_STALE/);
  assert.equal(await page.getByRole('alert').count(), 0);
  owner = true; statusFailure = false; await page.reload();
  await page.getByText('PRIVATE_D1 diagnostic').waitFor(); await page.getByText('PRIVATE_MODEL diagnostic').waitFor();
  await page.getByRole('heading', { name: 'Stripe billing' }).waitFor();
  await page.evaluate(() => { window.__setupMode = 'unmount'; });
  await page.getByRole('button', { name: 'Refresh live status' }).click();
  await page.waitForFunction(() => window.__setupPending.length === 1);
  assert.equal(await page.evaluate(() => {
    window.__unmountMarker = true; window.__setupRoot.unmount();
    return window.__setupSignals.at(-1).aborted;
  }), true);
  await page.evaluate(() => window.__setupPending.shift()({ status: 401 }));
  await page.waitForTimeout(150);
  assert.equal(await page.evaluate(() => window.__unmountMarker), true, 'late unauthorized response cannot redirect after unmount');
  assert.deepEqual(errors, []);
});
