import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { validateSchema, isId } from "../../../packages/atlas-contracts/src/index.mjs";
import { BrowserWorker, BrowserWorkerError } from "../src/browser-worker.mjs";
import { browserToolDefinitions } from "../src/tools.mjs";
import { verifyExtraction } from "../src/verify.mjs";
import { startServer, skipBrowser } from "./helpers.mjs";

let other;
let site;
let worker;

describe("browser worker", { skip: skipBrowser }, () => {
  before(async () => {
    other = await startServer();
    site = await startServer({ otherOrigin: other.origin });
    worker = new BrowserWorker({ allowedOrigins: [site.origin, other.origin] });
  });

  after(async () => {
    await worker?.closeAll();
    await site?.close();
    await other?.close();
  });

  test("single agent flow: navigate, click by role, extract, screenshot, close", async () => {
    const tools = Object.fromEntries(browserToolDefinitions(worker).map((tool) => [tool.name, tool]));
    const run = async (name, input) => {
      assert.deepEqual(validateSchema(tools[name].inputSchema, input), [], `${name} input should validate`);
      return tools[name].execute(input, {});
    };

    const { output: created } = await run("browser.create_session", { allowedOrigins: [site.origin] });
    const sessionId = created.sessionId;
    assert.ok(isId(sessionId, "workerSession"));
    assert.deepEqual(created.allowedOrigins, [site.origin]);

    const nav = await run("browser.navigate", { sessionId, url: `${site.origin}/?token=abc123` });
    assert.equal(nav.output.status, 200);
    assert.equal(nav.output.untrusted, true);
    assert.equal(nav.output.postcondition.originAllowed, true);

    const a11y = await run("browser.inspect_accessibility", { sessionId });
    assert.match(a11y.output.snapshot, /link "View quote"/);
    assert.equal(a11y.output.untrusted, true);

    const clicked = await run("browser.click", { sessionId, target: { role: "link", name: "View quote" } });
    assert.equal(clicked.output.postcondition.navigated, true);
    assert.equal(clicked.output.postcondition.urlAfter, `${site.origin}/quote.html`);

    const extracted = await run("browser.extract", { sessionId, fields: { total: { testId: "quote-total" }, heading: { role: "heading", name: "Quote" } } });
    assert.deepEqual(extracted.output.values, { total: "1,234.56", heading: "Quote" });
    assert.equal(extracted.output.untrusted, true);

    const verdict = verifyExtraction({ artifactContent: extracted.output, expected: { total: "1,234.56", heading: { pattern: "Q\\w+" } } });
    assert.equal(verdict.ok, true);
    assert.equal(verdict.evidence.length, 2);
    assert.equal(verifyExtraction({ artifactContent: extracted.output, expected: { total: "1,234.57" } }).ok, false);

    const shot = await run("browser.screenshot", { sessionId });
    assert.equal(shot.output.mediaType, "image/png");
    const bytes = Buffer.from(shot.output.bytes, "base64");
    assert.equal(bytes.subarray(1, 4).toString(), "PNG");
    assert.equal(shot.output.digest, `sha256:${createHash("sha256").update(bytes).digest("hex")}`);
    assert.equal(shot.evidence[0].digest, shot.output.digest);

    const closed = await run("browser.close_session", { sessionId });
    assert.equal(closed.output.closed, true);
    const trace = closed.output.trace;
    assert.deepEqual(trace.map((e) => e.action), [
      "create_session", "navigate", "inspect_accessibility", "click", "extract", "screenshot", "close_session",
    ]);
    assert.ok(trace.every((e) => typeof e.at === "string" && "ok" in e && "url" in e));
    const serialized = JSON.stringify(trace);
    assert.ok(!serialized.includes("abc123"), "token query parameter must be redacted from trace");
    assert.ok(!serialized.includes("1,234.56"), "extracted values are not written into the trace");

    await assert.rejects(() => worker.navigate(sessionId, { url: site.origin }), { code: "SESSION_CLOSED" });
  });

  test("disallowed origins: navigation refused, subresources aborted, redirects and off-origin clicks close the session", async () => {
    const { sessionId } = await worker.createSession({ allowedOrigins: [site.origin] });
    await assert.rejects(() => worker.navigate(sessionId, { url: "http://example.invalid/" }), { code: "ORIGIN_NOT_ALLOWED" });
    await assert.rejects(() => worker.navigate(sessionId, { url: `${other.origin}/` }), { code: "ORIGIN_NOT_ALLOWED" });

    other.hits.length = 0;
    await worker.navigate(sessionId, { url: `${site.origin}/beacon.html` });
    await worker.waitForState(sessionId, { loadState: "load" });
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.deepEqual(other.hits, [], "the other origin must never receive a request");
    const described = worker.describeSession(sessionId);
    const blocked = described.blockedRequests.map((r) => new URL(r.url).pathname);
    assert.ok(blocked.includes("/tracker.png"), `img should be blocked: ${blocked}`);
    assert.ok(blocked.includes("/exfil"), `fetch should be blocked: ${blocked}`);

    await assert.rejects(() => worker.click(sessionId, { role: "link", name: "Offsite" }), { code: "LEFT_ALLOWED_ORIGINS" });
    assert.equal(worker.describeSession(sessionId).open, false);
    assert.deepEqual(other.hits, []);

    const second = await worker.createSession({ allowedOrigins: [site.origin] });
    await assert.rejects(() => worker.navigate(second.sessionId, { url: `${site.origin}/redirect` }), { code: "LEFT_ALLOWED_ORIGINS" });
    assert.equal(worker.describeSession(second.sessionId).open, false);
    assert.deepEqual(other.hits, [], "the redirect target must not be fetched");
    assert.ok(worker.describeSession(second.sessionId).blockedRequests.some((r) => r.resourceType === "proxy" && r.url.endsWith("/landing")),
      "the redirect hop is refused by the egress proxy");

    await assert.rejects(() => worker.createSession({ allowedOrigins: ["https://not-in-ceiling.example"] }), { code: "ORIGIN_NOT_PERMITTED" });
  });

  test("file:, javascript:, data: and credentialed URLs are refused", async () => {
    const { sessionId } = await worker.createSession({ allowedOrigins: [site.origin] });
    for (const url of ["file:///etc/passwd", "javascript:alert(1)", "data:text/html,<h1>x</h1>", "ftp://127.0.0.1/"]) {
      await assert.rejects(() => worker.navigate(sessionId, { url }), { code: "UNSUPPORTED_SCHEME" }, url);
    }
    await assert.rejects(() => worker.navigate(sessionId, { url: site.origin.replace("http://", "http://user:pw@") }), { code: "CREDENTIALS_IN_URL" });
    await assert.rejects(() => worker.navigate(sessionId, { url: "not a url" }), { code: "INVALID_URL" });
    assert.throws(() => new BrowserWorker({ allowedOrigins: ["file:///"] }), BrowserWorkerError);
    const trace = worker.getTrace(sessionId);
    assert.ok(trace.filter((e) => e.action === "navigate").every((e) => e.ok === false));
    await worker.closeSession(sessionId);
  });

  test("session wall-clock expiry closes the session", async () => {
    const { sessionId, limits } = await worker.createSession({ allowedOrigins: [site.origin], maxSessionMs: 400 });
    assert.equal(limits.maxSessionMs, 400);
    await worker.navigate(sessionId, { url: site.origin });
    await new Promise((resolve) => setTimeout(resolve, 700));
    const described = worker.describeSession(sessionId);
    assert.equal(described.open, false);
    assert.equal(described.closeReason, "expired");
    await assert.rejects(() => worker.extract(sessionId, { fields: { h: { role: "heading" } } }), { code: "SESSION_EXPIRED" });
  });

  test("typed text and credential fields are redacted in the trace; postconditions verified; submit is separate", async () => {
    const { sessionId } = await worker.createSession({ allowedOrigins: [site.origin] });
    await worker.navigate(sessionId, { url: `${site.origin}/quote.html` });
    const typedEmail = await worker.type(sessionId, { target: { label: "Email" }, text: "person@example.com" });
    assert.equal(typedEmail.postcondition.valueMatches, true);
    const typedPw = await worker.type(sessionId, { target: { label: "Password" }, text: "hunter2-super-secret" });
    assert.equal(typedPw.postcondition.valueMatches, true);
    const selected = await worker.select(sessionId, { target: { label: "Plan" }, values: ["pro"] });
    assert.deepEqual(selected.postcondition.selected, ["pro"]);
    await assert.rejects(() => worker.click(sessionId, { role: "button", name: "Nope" }), { code: "ELEMENT_NOT_FOUND" });

    const submitted = await worker.submit(sessionId, { role: "button", name: "Place order" });
    assert.equal(submitted.postcondition.navigated, true);
    assert.match(submitted.postcondition.urlAfter, /\/thanks\.html\?/);
    const { values } = await worker.extract(sessionId, { fields: { confirmation: { testId: "confirmation" } } });
    assert.equal(values.confirmation, "ORDER-0001");

    const trace = worker.getTrace(sessionId);
    const serialized = JSON.stringify(trace);
    assert.ok(!serialized.includes("person@example.com"), "typed email must be redacted");
    assert.ok(!serialized.includes("hunter2"), "typed password must not appear, even in the submitted URL");
    const typeEntries = trace.filter((e) => e.action === "type");
    assert.equal(typeEntries.length, 2);
    assert.match(typeEntries[0].args.text, /^\[REDACTED:\d+ chars\]$/);
    const submitEntry = trace.find((e) => e.action === "submit");
    assert.match(submitEntry.url, /password=%5BREDACTED%5D/);
    await worker.closeSession(sessionId);
  });

  test("tool definitions: strict schemas, risks, consequential submit", async () => {
    const tools = browserToolDefinitions(worker);
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    assert.deepEqual(Object.keys(byName).sort(), [
      "browser.click", "browser.close_session", "browser.create_session", "browser.extract", "browser.inspect_accessibility",
      "browser.inspect_dom", "browser.navigate", "browser.screenshot", "browser.scroll", "browser.select", "browser.submit",
      "browser.type", "browser.wait_for_state",
    ]);
    for (const tool of tools) assert.equal(tool.inputSchema.additionalProperties, false, tool.name);
    assert.equal(byName["browser.submit"].consequential, true);
    assert.equal(byName["browser.submit"].risk, "high");
    for (const name of ["browser.click", "browser.type", "browser.select"]) {
      assert.equal(byName[name].risk, "moderate");
      assert.equal(byName[name].consequential, false);
    }
    const sid = `wks_${"0".repeat(32)}`;
    const unknown = validateSchema(byName["browser.navigate"].inputSchema, { sessionId: sid, url: "http://x", headers: {} });
    assert.ok(unknown.some((e) => e.path === "$.headers" && /not an allowed property/.test(e.message)));
    const nestedUnknown = validateSchema(byName["browser.click"].inputSchema, { sessionId: sid, target: { role: "link", xpath: "//a" } });
    assert.ok(nestedUnknown.some((e) => e.path === "$.target.xpath"));
    const extractUnknown = validateSchema(byName["browser.extract"].inputSchema, { sessionId: sid, fields: { a: { testId: "x", js: "1" } } });
    assert.ok(extractUnknown.some((e) => e.path === "$.fields.a.js"));
    assert.ok(validateSchema(byName["browser.navigate"].inputSchema, { sessionId: "bad", url: "http://x" }).length > 0);
    assert.ok(validateSchema(byName["browser.submit"].inputSchema, { sessionId: sid, target: { role: "button" } }).some((e) => e.path === "$.intent"));
  });

  test("inspect_dom, scroll, wait_for_state and downloads-disabled defaults", async () => {
    const { sessionId, limits } = await worker.createSession({ allowedOrigins: [site.origin], viewport: { width: 400, height: 300 } });
    assert.equal(limits.maxDownloads, 0);
    await worker.navigate(sessionId, { url: `${site.origin}/quote.html` });
    const dom = await worker.inspectDom(sessionId, { selector: "form", maxChars: 200 });
    assert.match(dom.html, /^<form/);
    assert.equal(dom.truncated, true);
    assert.equal(dom.untrusted, true);
    const scrolled = await worker.scroll(sessionId, { target: { role: "button", name: "Place order" } });
    assert.ok(scrolled.position);
    const waited = await worker.waitForState(sessionId, { target: { testId: "quote-total" }, state: "visible" });
    assert.equal(waited.reached, "visible");
    await assert.rejects(() => worker.waitForState(sessionId, { target: { testId: "never" }, timeoutMs: 200 }), { code: "ACTION_TIMEOUT" });
    await worker.closeSession(sessionId);
  });
});

test("verifyExtraction is deterministic and fails closed", () => {
  assert.equal(verifyExtraction({ artifactContent: { total: "1,234.56" }, expected: { total: { pattern: "[\\d,]+\\.\\d{2}" } } }).ok, true);
  assert.equal(verifyExtraction({ artifactContent: { total: "x1,234.56" }, expected: { total: { pattern: "[\\d,]+\\.\\d{2}" } } }).ok, false);
  assert.equal(verifyExtraction({ artifactContent: {}, expected: { total: "1" } }).ok, false);
  assert.equal(verifyExtraction({ artifactContent: { a: "1" }, expected: {} }).ok, false);
  assert.equal(verifyExtraction({ artifactContent: { a: "1" }, expected: { a: { pattern: "(" } } }).ok, false);
});
