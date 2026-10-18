import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
let playwright;
try { playwright = await import(process.env.ATLAS_TEST_PLAYWRIGHT ? pathToFileURL(process.env.ATLAS_TEST_PLAYWRIGHT).href : 'playwright-core'); }
catch { /* Browser acceptance is optional without a configured runtime. */ }

test('actual Connections view keeps customer status separate from owner diagnostics', { skip: !playwright && 'Configure Playwright', timeout: 60000 }, async t => {
  const { createServer } = await import('vite'); const { default: react } = await import('@vitejs/plugin-react');
  const html = '<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module">import React from "react";import{createRoot}from"react-dom/client";import{SetupCenter}from"/app/setup/SetupCenter.tsx";createRoot(document.getElementById("root")).render(React.createElement(SetupCenter));</script></body></html>';
  const server = await createServer({ root: fileURLToPath(new URL('../', import.meta.url)), configFile: false, cacheDir: '../../.setup-privacy-cache', plugins: [{
    name: 'setup-boundary-fixture', enforce: 'pre',
    resolveId(id, importer) { if (id === 'next/link') return '\0setup-link'; if (id === '../AtlasShell.js' && importer?.includes('SetupCenter')) return '\0setup-shell'; },
    load(id) { if (id === '\0setup-link') return 'import React from "react";export default function Link(props){return React.createElement("a",props)}'; if (id === '\0setup-shell') return 'import React from "react";export function AtlasShell({children,headerContext}){return React.createElement("main",null,headerContext,children)}'; },
    configureServer(vite) { vite.middlewares.use((req, res, next) => { if (req.url !== '/') return next(); void vite.transformIndexHtml('/', html).then(body => { res.setHeader('Content-Type', 'text/html'); res.end(body); }); }); },
  }, react()], resolve: { dedupe: ['react', 'react-dom'] }, server: { host: '127.0.0.1', port: 0 } });
  await server.listen(); t.after(() => server.close());
  const browser = await playwright.chromium.launch({ headless: true, ...(process.env.ATLAS_TEST_BROWSER ? { executablePath: process.env.ATLAS_TEST_BROWSER } : {}) }); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } }); const errors = []; page.on('pageerror', error => errors.push(error.message));
  let owner = false; let statusFailure = false;
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    let body = {};
    if (path === '/api/setup/status') {
      if (statusFailure) return route.fulfill({ status: 503, json: { message: 'PRIVATE_BACKEND /srv/deploy' } });
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
  owner = true; statusFailure = false; await page.reload();
  await page.getByText('PRIVATE_D1 diagnostic').waitFor(); await page.getByText('PRIVATE_MODEL diagnostic').waitFor();
  await page.getByRole('heading', { name: 'Stripe billing' }).waitFor();
  assert.deepEqual(errors, []);
});
