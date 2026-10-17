import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

let playwright;
try { playwright = await import(process.env.ATLAS_TEST_PLAYWRIGHT ? pathToFileURL(process.env.ATLAS_TEST_PLAYWRIGHT).href : "playwright-core"); }
catch { /* Browser acceptance is optional without configured Playwright. */ }

const key = "11111111-1111-4111-8111-111111111111";
const saved = objective => ({ requestKey: key, createdAt: "2026-10-17 00:00:00", state: "task-saved", receiptState: "reserved", outcomeStatus: null,
  task: { taskId: key, conversationId: key, repository: "owner/repo", branch: "main", objective, dispatchState: "unknown" } });

test("actual saved-request panel recovers after close, refresh and paging on desktop and mobile", {
  skip: !playwright && "Configure Playwright for browser acceptance", timeout: 60_000,
}, async t => {
  const { createServer } = await import("vite");
  const { default: react } = await import("@vitejs/plugin-react");
  const html = '<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module">import React from "react";import {createRoot} from "react-dom/client";import {RequestHistory} from "/app/build/RequestHistory.tsx";createRoot(document.getElementById("root")).render(React.createElement(RequestHistory));</script></body></html>';
  const server = await createServer({
    root: fileURLToPath(new URL("../", import.meta.url)), configFile: false,
    cacheDir: "../../.request-history-browser-cache", resolve: { dedupe: ["react", "react-dom"] },
    plugins: [react(), { name: "request-history-fixture", configureServer(vite) {
      vite.middlewares.use((request, response, next) => {
        if (request.url !== "/") return next();
        void vite.transformIndexHtml("/", html).then(body => { response.setHeader("Content-Type", "text/html"); response.end(body); });
      });
    } }], server: { host: "127.0.0.1", port: 0 },
  });
  await server.listen(); t.after(() => server.close());
  const browser = await playwright.chromium.launch({ headless: true, ...(process.env.ATLAS_TEST_BROWSER ? { executablePath: process.env.ATLAS_TEST_BROWSER } : {}) });
  t.after(() => browser.close());
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;

  for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
    const page = await browser.newPage({ viewport });
    const errors = []; const calls = []; const details = [];
    let phase = "Initial request";
    let detailArrived;
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/api/tasks/requests**", async route => {
      const request = route.request(); calls.push({ method: request.method(), body: request.postData() });
      if (new URL(request.url()).pathname.endsWith(`/${key}`)) {
        details.push(route); detailArrived?.(); return;
      }
      const older = new URL(request.url()).searchParams.has("cursor");
      await route.fulfill({ json: { requests: [saved(older ? "Older request page" : phase)], nextCursor: older ? null : "older-page" } });
    });
    const check = async () => {
      const arrived = new Promise(resolve => { detailArrived = resolve; });
      await page.getByRole("button", { name: "Check request" }).click(); await arrived;
    };
    const discardLate = async (route, status, body) => {
      // Cancellation may already have closed Chromium's intercepted request.
      await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) }).catch(() => {});
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    };
    await page.goto(origin);
    const summary = page.locator("details > summary");
    await summary.focus(); await page.keyboard.press("Enter");
    await page.getByRole("heading", { name: phase }).waitFor();
    await check();
    await summary.click(); assert.equal(await page.locator("details").getAttribute("open"), null);
    phase = "Reopened request"; await summary.click();
    await page.getByRole("heading", { name: phase }).waitFor();
    await discardLate(details[0], 200, { request: saved("STALE_DETAIL") });
    assert.equal(await page.getByRole("heading", { name: phase }).count(), 1);
    assert.doesNotMatch(await page.locator("body").innerText(), /STALE_DETAIL/);

    await check(); phase = "Refreshed request";
    await page.getByRole("button", { name: "Refresh requests" }).click();
    await page.getByRole("heading", { name: phase }).waitFor();
    await discardLate(details[1], 503, { message: "PRIVATE_PROVIDER_DIAGNOSTIC" });
    assert.equal(await page.getByRole("heading", { name: phase }).count(), 1);
    assert.doesNotMatch(await page.locator("body").innerText(), /PRIVATE_PROVIDER_DIAGNOSTIC|This request is unavailable/);
    await page.getByRole("button", { name: "Older", exact: true }).click();
    await page.getByRole("heading", { name: "Older request page" }).waitFor();
    await page.getByRole("button", { name: "Newer", exact: true }).click();
    await page.getByRole("heading", { name: phase }).waitFor();
    assert.ok((await page.getByRole("button", { name: "Check request" }).boundingBox()).height >= 44);
    assert.ok(calls.length >= 6);
    assert.ok(calls.every(call => call.method === "GET" && call.body === null));
    assert.deepEqual(errors, []);
    await page.close();
  }
});
