import assert from "node:assert/strict";
import { createServer } from "node:http";
import { register } from "node:module";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { migratedDatabase } from "./helpers/d1-sqlite.mjs";

register(`data:text/javascript,${encodeURIComponent(`
  export async function resolve(specifier, context, next) {
    if (specifier === "cloudflare:workers") return { url: "data:text/javascript,export const env = globalThis.__hostedSiteEnv; export class DurableObject {}", shortCircuit: true };
    return next(specifier, context);
  }
`)}`, import.meta.url);

let playwright;
try { playwright = await import(process.env.ATLAS_TEST_PLAYWRIGHT ? pathToFileURL(process.env.ATLAS_TEST_PLAYWRIGHT).href : "playwright-core"); }
catch { /* Browser acceptance is optional without a configured runtime. */ }

const HAHN = "Build a responsive website for Team Hahn Construction in Eagan, Minnesota, specializing in wood framing, windows, doors, and housewrap.";
const context = { waitUntil() {}, passThroughOnException() {} };

test("hosted chat builds the Team Hahn site, persists it, and serves a working preview", { timeout: 120_000 }, async (t) => {
  const { sqlite, d1 } = migratedDatabase();
  globalThis.__hostedSiteEnv = { DB: d1 };
  const configuration = { ATLAS_OPERATOR_TOKEN: "test-hosted-site", ATLAS_CHAT_BASE_URL: "http://127.0.0.1:11434/v1", ATLAS_CHAT_MODEL: "qwen3:0.6b", ATLAS_CHAT_FALLBACK_MODEL: "none" };
  const previous = Object.fromEntries(Object.keys(configuration).map((key) => [key, process.env[key]]));
  Object.assign(process.env, configuration);
  const originalFetch = globalThis.fetch;
  const modelCalls = [];
  // A scripted model: asks for the project once, then reports exactly what the tool returned.
  globalThis.fetch = async (url, options) => {
    const sent = JSON.parse(options.body);
    modelCalls.push(sent);
    const tool = [...sent.messages].reverse().find((message) => message.role === "tool");
    const message = tool
      ? { role: "assistant", content: (() => { const result = JSON.parse(tool.content); return `Built ${result.name}. Preview: ${result.previewUrl}. ${result.message}`; })() }
      : { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "workspace_create_project", arguments: JSON.stringify({ name: "team-hahn-construction", description: HAHN, template: "static-site" }) } }] };
    const body = { choices: [{ message, finish_reason: tool ? "stop" : "tool_calls" }], usage: { prompt_tokens: 10, completion_tokens: 10 } };
    return sent.stream ? new Response(`data: ${JSON.stringify({ choices: [{ delta: message, finish_reason: body.choices[0].finish_reason }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } }) : Response.json(body);
  };
  t.after(() => {
    globalThis.fetch = originalFetch; delete globalThis.__hostedSiteEnv; sqlite.close();
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  });
  const { default: worker } = await import(new URL("../dist/server/index.js", import.meta.url));
  const invoke = (path, init = {}) => worker.fetch(new Request(`http://atlas.test${path}`, init), globalThis.__hostedSiteEnv, context);
  const authorization = { authorization: "Bearer test-hosted-site", "content-type": "application/json" };

  const chat = await invoke("/api/chat", { method: "POST", headers: authorization, body: JSON.stringify({ message: HAHN }) });
  assert.equal(chat.status, 200, await chat.clone().text());
  const answer = (await chat.json()).reply.content;
  const toolTurn = modelCalls.find((call) => call.tools?.some((tool) => tool.function.name === "workspace_create_project"));
  assert.ok(toolTurn, "the project tool is offered for a website request");
  assert.equal(toolTurn.tools.some((tool) => tool.function.name === "start_atlas_task"), false, "a new website never dispatches work against the selected repository");
  assert.match(toolTurn.messages[0].content, /hostedWebsites":\s*true/u, "the model is told the hosted builder exists");

  const row = sqlite.prepare("SELECT id, name, status, preview_url AS previewUrl, requirements_json AS requirements FROM genesis_projects").get();
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM genesis_projects").get().n, 1);
  assert.equal(row.name, "Team Hahn Construction");
  assert.equal(row.status, "ready");
  assert.equal(JSON.parse(row.requirements).spec.location.city, "Eagan");
  assert.match(answer, new RegExp(`Preview: ${row.previewUrl}`, "u"));
  assert.match(answer, /Nothing is published|nothing is published/u);

  // The preview needs no sign-in and renders from the stored site.
  const home = await invoke(row.previewUrl);
  assert.equal(home.status, 200);
  const html = await home.text();
  assert.match(html, /Team Hahn Construction in Eagan, Minnesota/u);
  for (const file of ["services.html", "about.html", "gallery.html", "contact.html", "styles.css", "contact.js"]) assert.equal((await invoke(`${row.previewUrl}/${file}`)).status, 200, file);
  assert.equal((await invoke(`/preview/gen_00000000-aaaa-4bbb-8ccc-dddddddddddd`)).status, 404);
  assert.equal((await invoke(`${row.previewUrl}/..%2Fsecret.html`)).status, 404);

  // The project card's status poll sees the same project, only through its own workspace.
  const status = await invoke(`/api/genesis/operations?id=${row.id}`, { headers: authorization });
  assert.equal((await status.json()).status, "ready");

  if (!playwright) return t.diagnostic("Chromium acceptance skipped: no Playwright runtime configured.");
  const server = createServer(async (request, response) => {
    const result = await invoke(request.url, { method: request.method });
    response.writeHead(result.status, Object.fromEntries(result.headers));
    response.end(Buffer.from(await result.arrayBuffer()));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await playwright.chromium.launch({ headless: true, ...(process.env.ATLAS_TEST_BROWSER ? { executablePath: process.env.ATLAS_TEST_BROWSER } : {}) });
  t.after(() => browser.close());
  for (const [label, width, height] of [["phone", 375, 812], ["desktop", 1280, 800]]) {
    const page = await browser.newPage({ viewport: { width, height } });
    const problems = []; const failed = [];
    page.on("pageerror", (error) => problems.push(error.message));
    page.on("console", (message) => { if (message.type() === "error") problems.push(message.text()); });
    page.on("response", (response) => { if (response.status() >= 400) failed.push(`${response.status()} ${response.url()}`); });
    await page.goto(`${origin}${row.previewUrl}`);
    assert.equal(await page.locator("h1").innerText(), "Team Hahn Construction in Eagan, Minnesota", label);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `${label}: no horizontal overflow`);
    assert.equal(await page.locator(".atlas-preview-bar").isVisible(), true, `${label}: the preview says it is not published`);
    for (const title of ["Services", "About", "Gallery", "Contact"]) {
      await page.locator("nav a", { hasText: title }).click();
      await page.waitForURL(new RegExp(`${title.toLowerCase()}\\.html$`, "u"));
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `${label}: ${title} fits`);
    }
    // The enquiry form validates, then states plainly that the preview does not send.
    await page.getByRole("button", { name: "Send enquiry" }).click();
    assert.match(await page.locator("#enquiry-error").innerText(), /tell us your name/iu);
    await page.fill("#name", "Pat"); await page.fill("#email", "pat@example.com"); await page.fill("#message", "Need framing quotes");
    await page.getByRole("button", { name: "Send enquiry" }).click();
    assert.match(await page.locator("#enquiry-error").innerText(), /enquiries are not sent/iu);
    assert.equal(await page.locator("#enquiry-done").isVisible(), false, `${label}: no false "thank you"`);
    assert.deepEqual(problems, [], `${label}: no console or page errors`);
    assert.deepEqual(failed, [], `${label}: every request succeeded`);
    await page.close();
  }
});
