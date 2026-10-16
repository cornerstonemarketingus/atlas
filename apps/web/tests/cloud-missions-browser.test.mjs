import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync, mkdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { missionRoutes } from "../app/api/missions/http.mjs";
import { migratedDatabase } from "./helpers/d1-sqlite.mjs";
let playwright;
try { playwright = process.env.ATLAS_TEST_PLAYWRIGHT ? await import(pathToFileURL(process.env.ATLAS_TEST_PLAYWRIGHT).href) : await import("playwright-core"); } catch { /* opt-in browser gate */ }
test("real cloud mission screen reconnects on desktop/mobile without duplicate dispatch", { skip: !playwright && "Configure Playwright", timeout: 90000 }, async t => {
  const { createServer } = await import("vite");
  const { default: react } = await import("@vitejs/plugin-react");
  const { sqlite, d1 } = migratedDatabase();
  sqlite.exec(readFileSync(new URL("../drizzle/0021_cloud_missions.sql", import.meta.url), "utf8"));
  const batch = d1.batch; let tail = Promise.resolve();
  d1.batch = statements => { const next = tail.then(() => batch(statements)); tail = next.catch(() => {}); return next; };
  let calls = 0; let finished = false;
  const handle = missionRoutes({ database: () => d1, authenticate: async () => ({}), resolveScope: async () => ({ tenantId: 1, principal: "operator" }),
    dispatch: async (_request, _scope, step) => { calls++; return { taskId: randomUUID(), correlationId: step.correlationId }; },
    receipt: async () => null, outcome: async () => finished ? ({ status: "completed", evidence: { receiptId: "signed-result", summary: "Recorded runner result", runUrl: "https://github.com/owner/repo/actions/runs/1" } }) : ({ status: "pending" }) });
  const root = fileURLToPath(new URL("../", import.meta.url)).replaceAll("\\", "/");
  const html = '<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0"><div id="root"></div><script type="module">import React from "react";import {createRoot} from "react-dom/client";import {MissionsSection} from "/app/missions/MissionsSection.tsx";import "/app/globals.css";import "/app/workspace.css";import "/app/atlas-shell.css";import "/app/atlas-brand.css";createRoot(document.getElementById("root")).render(React.createElement(MissionsSection));</script></body></html>';
  const server = await createServer({ root, configFile: false, cacheDir: "../../.review/mission-browser-cache", define: { "process.env": "{}" },
    optimizeDeps: { include: ["react", "react-dom/client", "next/link", "next/router", "next/navigation"] },
    resolve: { alias: Object.fromEntries(["link", "router", "navigation"].map(name => [`next/${name}`, fileURLToPath(import.meta.resolve(`vinext/shims/${name}`))])), dedupe: ["react", "react-dom"] },
    plugins: [react(), { name: "real-mission-http", configureServer(vite) { vite.middlewares.use((request, response, next) => {
      const url = new URL(request.url, "http://fixture");
      if (url.pathname === "/" && !url.searchParams.has("html-proxy")) { void vite.transformIndexHtml(request.url, html).then(body => { response.setHeader("Content-Type", "text/html"); response.end(body); }); return; }
      if (url.pathname.startsWith("/api/missions")) {
        void (async () => { const chunks = []; for await (const chunk of request) chunks.push(chunk); const id = url.pathname.split("/")[3] || null;
          const result = await handle(new Request(url, { method: request.method, headers: { "content-type": "application/json" }, ...(request.method === "POST" ? { body: Buffer.concat(chunks) } : {}) }), id);
          response.writeHead(result.status, { "content-type": "application/json" }); response.end(await result.text());
        })().catch(error => { response.statusCode = 500; response.end(JSON.stringify({ message: error.message })); }); return;
      }
      if (url.pathname.startsWith("/api/")) { response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify({ signedIn: true })); return; }
      next();
    }); } }], server: { host: "127.0.0.1", port: 0 } });
  await server.listen(); let browser;
  t.after(async () => { await browser?.close(); await server.close(); sqlite.close(); });
  browser = await playwright.chromium.launch({ headless: true, ...(process.env.ATLAS_TEST_BROWSER ? { executablePath: process.env.ATLAS_TEST_BROWSER } : {}) });
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  const screenshots = fileURLToPath(new URL("../../../.review/", import.meta.url)); mkdirSync(screenshots, { recursive: true });
  for (const mobile of [false, true]) {
    finished = false; const before = calls;
    const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 }, isMobile: mobile, hasTouch: mobile });
    const page = await context.newPage(); const errors = []; page.on("pageerror", error => errors.push(error.message));
    await page.goto(origin);
    const objective = mobile ? "Mobile persistent review" : "Desktop persistent review";
    await page.getByLabel("Overall objective", { exact: true }).fill(objective);
    await page.getByLabel("Connected repository", { exact: true }).fill("owner/repo");
    await page.getByLabel("Steps, one concrete objective per line", { exact: true }).fill("Inspect README.md and report issues");
    await page.getByRole("button", { name: "Save mission", exact: true }).click();
    await page.getByRole("heading", { name: objective, exact: true }).waitFor();
    assert.equal(calls, before, "saving alone does not execute");
    await page.getByRole("button", { name: "Start / reconcile", exact: true }).click();
    await page.locator(".mission-detail li strong").filter({ hasText: "submitted" }).waitFor();
    await page.reload();
    await page.getByRole("button", { name: new RegExp(objective) }).click();
    await page.getByRole("heading", { name: objective, exact: true }).waitFor();
    assert.equal(calls, before + 1, "reopening never duplicates dispatch");
    finished = true;
    await page.getByRole("button", { name: "Start / reconcile", exact: true }).click();
    await page.getByText("Recorded runner result", { exact: true }).waitFor();
    assert.equal(calls, before + 1);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: `${screenshots}/mission-${mobile ? "mobile" : "desktop"}.png`, fullPage: true });
    assert.deepEqual(errors, []); await context.close();
  }
});
