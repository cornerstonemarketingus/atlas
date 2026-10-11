import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

// Opt-in browser gate: uses the real React ChatSection and production styles,
// deterministic HTTP/SSE fixtures, and no provider credentials or live inference.
// ATLAS_TEST_PLAYWRIGHT points to a Playwright entry module when not installed.
// ATLAS_TEST_BROWSER optionally selects an installed Chromium executable.
let playwright;
try {
  playwright = process.env.ATLAS_TEST_PLAYWRIGHT
    ? await import(pathToFileURL(process.env.ATLAS_TEST_PLAYWRIGHT).href)
    : await import("playwright-core");
} catch { /* Browser is optional for the ordinary dependency-free test run. */ }

test("real chat preserves desktop/mobile reading position through SSE, polling and navigation", {
  skip: !playwright && "Configure Playwright to run the browser gate",
  timeout: 60_000,
}, async (t) => {
  const { createServer } = await import("vite");
  const { default: react } = await import("@vitejs/plugin-react");
  const root = fileURLToPath(new URL("../", import.meta.url)).replace(/\\/gu, "/");
  const first = "11111111-1111-4111-8111-111111111111";
  const second = "22222222-2222-4222-8222-222222222222";
  const history = Array.from({ length: 35 }, (_, id) => ({ id: `m${id}`, role: "assistant", content: `Earlier computation ${id}. ${"Evidence and calculations. ".repeat(25)}`, createdAt: "2030-01-01T00:00:00Z" }));
  let activeResponse;
  const html = `<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0"><div id="root"></div><script type="module">
    import React from 'react'; import {createRoot} from 'react-dom/client';
    import {ChatSection} from '/app/chat/ChatSection.tsx';
    import '/app/globals.css'; import '/app/workspace.css';
    import '/app/atlas-shell.css'; import '/app/atlas-brand.css';
    createRoot(document.getElementById('root')).render(React.createElement(ChatSection));
  </script></body></html>`;
  const server = await createServer({
    root, configFile: false, cacheDir: "../../.review/chat-scroll-cache",
    define: { "process.env": "{}" },
    optimizeDeps: { include: ["react", "react-dom/client", "next/link", "next/router", "next/navigation"] },
    plugins: [react(), {
      name: "chat-http-fixture",
      configureServer(vite) {
        vite.middlewares.use((request, response, next) => {
          const url = new URL(request.url, "http://fixture");
          if (url.pathname === "/" && !url.searchParams.has("html-proxy")) {
            void vite.transformIndexHtml(request.url, html).then((body) => { response.setHeader("Content-Type", "text/html"); response.end(body); });
            return;
          }
          if (!url.pathname.startsWith("/api/")) return next();
          if (url.pathname === "/api/chat" && request.method === "POST") {
            request.resume();
            response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
            response.flushHeaders(); activeResponse = response;
            return;
          }
          let body = {};
          if (url.pathname === "/api/chat") body = { configured: true };
          if (url.pathname === "/api/account") body = { signedIn: true };
          if (url.pathname === "/api/conversations") body = { conversations: [{ id: first, title: "First thread" }, { id: second, title: "Second thread" }] };
          if (url.pathname.startsWith("/api/conversations/")) body = { messages: history, tasks: [] };
          response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify(body));
        });
      },
    }],
    resolve: { alias: Object.fromEntries(["link", "router", "navigation"].map((name) => [`next/${name}`, fileURLToPath(import.meta.resolve(`vinext/shims/${name}`))])), dedupe: ["react", "react-dom"] },
    server: { host: "127.0.0.1", port: 0 },
  });
  await server.listen();
  let browser;
  t.after(async () => { activeResponse?.end(); await browser?.close(); await server.close(); });
  browser = await playwright.chromium.launch({ headless: true, ...(process.env.ATLAS_TEST_BROWSER ? { executablePath: process.env.ATLAS_TEST_BROWSER } : {}) });
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  const emit = (event, data) => activeResponse.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  for (const mobile of [false, true]) {
    const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1200, height: 800 }, isMobile: mobile, hasTouch: mobile });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${origin}/?conversation=${first}`);
    const scroll = page.getByLabel("Chat history", { exact: true });
    const bottom = () => page.waitForFunction(() => { const e = document.querySelector(".section-scroll"); return e && e.scrollHeight > e.clientHeight && e.scrollHeight - e.clientHeight - e.scrollTop < 3; });
    await bottom();
    await page.getByLabel("Message Atlas").fill("Explain the calculations");
    await page.getByLabel("Send", { exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[aria-label="Stop the reply"]'));
    emit("thinking", { text: "Live reasoning. ".repeat(30) });
    emit("delta", { text: "Working through the answer.\n\n".repeat(10) });
    await bottom();
    if (mobile) {
      const session = await context.newCDPSession(page);
      const box = await scroll.boundingBox();
      await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: box.x + 100, y: box.y + 100 }] });
      await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: box.x + 100, y: box.y + 150 }] });
      // Cancel the test gesture to avoid continued inertial movement while
      // asserting that streamed updates themselves do not move the reader.
      await session.send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] });
      await page.getByRole("button", { name: "Jump to latest" }).waitFor();
      await scroll.evaluate((e) => { e.scrollTop -= 400; });
    } else {
      await scroll.hover(); await page.mouse.wheel(0, -400);
    }
    const jump = page.getByRole("button", { name: "Jump to latest" });
    await jump.waitFor();
    await page.waitForTimeout(150); // allow wheel/touch momentum to settle
    const position = await scroll.evaluate((e) => e.scrollTop);
    for (let i = 0; i < 5; i++) emit("delta", { text: `New computation ${i}.\n\n`.repeat(12) });
    emit("tool", { id: "read", label: "Reading evidence", state: "running" });
    await page.getByText("New computation 4.", { exact: false }).first().waitFor();
    const afterOutput = await scroll.evaluate((e) => ({ top: e.scrollTop, bottom: e.scrollHeight - e.clientHeight }));
    assert.ok(Math.abs(afterOutput.top - position) < 2, `stream/tool updates preserve position: mobile=${mobile}, before=${position}, after=${JSON.stringify(afterOutput)}`);
    await jump.click(); await bottom();
    emit("delta", { text: "More output after Jump.\n\n".repeat(20) });
    await page.getByText("More output after Jump.", { exact: false }).first().waitFor(); await bottom();
    // Returning to the bottom via the actual scroll container also resumes follow.
    await scroll.evaluate((e) => { e.scrollTop -= 300; }); await jump.waitFor();
    await scroll.evaluate((e) => { e.scrollTop = e.scrollHeight; });
    await jump.waitFor({ state: "hidden" });
    emit("delta", { text: "Follow restored.\n\n".repeat(20) });
    await page.getByText("Follow restored.", { exact: false }).first().waitFor(); await bottom();
    // The same bug existed in the chat's activity panel; exercise its real
    // parent-owned log updates, rather than a second synthetic scroll element.
    for (let i = 0; i < 80; i++) emit("tool", { id: `activity-${i}`, label: `Inspecting evidence ${i}`, state: "done" });
    await page.getByRole("button", { name: "Terminal", exact: true }).click();
    const activity = page.getByRole("log", { name: "Activity log" });
    const activityBottom = () => page.waitForFunction(() => { const e = document.querySelector(".terminal"); return e && e.scrollHeight > e.clientHeight && e.scrollHeight - e.clientHeight - e.scrollTop < 3; });
    await activityBottom();
    await activity.evaluate((e) => { e.scrollTop = 100; });
    const activityJump = page.getByRole("button", { name: "Jump to latest activity", exact: true });
    await activityJump.waitFor();
    const activityPosition = await activity.evaluate((e) => e.scrollTop);
    emit("tool", { id: "activity-new", label: "Newest activity marker", state: "done" });
    await activity.getByText("✓ Newest activity marker", { exact: true }).waitFor();
    assert.ok(Math.abs(await activity.evaluate((e) => e.scrollTop) - activityPosition) < 2, "activity updates preserve the panel reader's position");
    await activityJump.click(); await activityBottom();
    await page.getByRole("button", { name: "Close panel", exact: true }).click();
    await bottom();
    await scroll.evaluate((e) => { e.scrollTop = 500; }); await jump.waitFor();
    const beforeCompletion = await scroll.evaluate((e) => e.scrollTop);
    emit("done", { reply: { id: "final", role: "assistant", content: "Completed calculations. ".repeat(100), createdAt: "2030-01-01T00:00:00Z" } });
    activeResponse.end(); activeResponse = null;
    await page.getByLabel("Send", { exact: true }).waitFor();
    await page.waitForTimeout(200);
    assert.ok(Math.abs(await scroll.evaluate((e) => e.scrollTop) - beforeCompletion) < 2, "completion and history refresh preserve position");
    if (mobile) await page.getByRole("button", { name: "Open navigation" }).click();
    await page.getByRole("button", { name: "Second thread", exact: true }).click();
    if (mobile) await page.locator(".rail-close").click();
    await bottom();
    await scroll.focus();
    await page.keyboard.press("PageUp");
    await jump.waitFor();
    await page.waitForTimeout(400); // native PageUp animation must finish before an explicit jump
    await jump.click(); await bottom();
    if (mobile) await page.getByRole("button", { name: "Open navigation" }).click();
    await page.getByRole("button", { name: "New chat", exact: false }).click();
    if (mobile) await page.locator(".rail-close").click();
    await page.getByRole("heading", { name: "What do you want to accomplish?" }).waitFor();
    await jump.waitFor({ state: "hidden" });
    assert.equal(await page.evaluate(() => window.scrollY), 0, "the outer page was never scrolled");
    assert.deepEqual(errors, []);
    await context.close();
  }
});
