import assert from "node:assert/strict";
import test from "node:test";
test("server-renders the Atlas control plane", async () => {
  const workerUrl = new URL(`../dist/server/index.js?test=${Date.now()}`, import.meta.url);
  const { default: worker } = await import(workerUrl.href);
  const response = await worker.fetch(new Request("http://localhost/", { headers: { accept: "text/html" } }), { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } }, { waitUntil() {}, passThroughOnException() {} });
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /Build it\.<br\/>Run it\.<br\/>Grow it\./);
  assert.match(html, /autonomous AI workspace that builds software, operates computers and turns successful work into persistent automations/);
  assert.match(html, /Go beyond the coding assistant/);
  assert.match(html, /Continue securely/);
  assert.match(html, /access code/i);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape/);
  assert.doesNotMatch(html, /GitHub Actions runner/);
});

test("server-renders the secure owner access page", async () => {
  const workerUrl = new URL(`../dist/server/index.js?owner-test=${Date.now()}`, import.meta.url);
  const { default: worker } = await import(workerUrl.href);
  const response = await worker.fetch(new Request("http://localhost/owner", { headers: { accept: "text/html" } }), { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } }, { waitUntil() {}, passThroughOnException() {} });
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /deployment-owner role/i);
  assert.match(html, /Continue with GitHub/i);
  assert.doesNotMatch(html, /ATLAS_OPERATOR_TOKEN/);
});

test("server-renders the public investor thesis", async () => {
  const workerUrl = new URL(`../dist/server/index.js?investor-test=${Date.now()}`, import.meta.url);
  const { default: worker } = await import(workerUrl.href);
  const response = await worker.fetch(new Request("http://localhost/investors", { headers: { accept: "text/html" } }), { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } }, { waitUntil() {}, passThroughOnException() {} });
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /execution layer after chat/i);
  assert.match(html, /ideas should not stop.*at an answer/is);
});

test("server-renders an honest parallel mission preview", async () => {
  const workerUrl = new URL(`../dist/server/index.js?parallel-test=${Date.now()}`, import.meta.url);
  const { default: worker } = await import(workerUrl.href);
  const response = await worker.fetch(new Request("http://localhost/product", { headers: { accept: "text/html" } }), { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } }, { waitUntil() {}, passThroughOnException() {} });
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /Parallel mission control/i);
  assert.match(html, /Research child/);
  assert.match(html, /Budget envelope/);
  assert.match(html, /Evidence stream/);
  assert.match(html, /product preview/i);
  assert.match(html, /not hidden chain-of-thought/i);
});

test("server-renders the login, controls, and self-protection guide", async () => {
  const workerUrl = new URL(`../dist/server/index.js?guide-test=${Date.now()}`, import.meta.url);
  const { default: worker } = await import(workerUrl.href);
  const response = await worker.fetch(new Request("http://localhost/guide", { headers: { accept: "text/html" } }), { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } }, { waitUntil() {}, passThroughOnException() {} });
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /Three access paths/i);
  assert.match(html, /Buying a plan.*does not create owner or deployment authority/is);
  assert.match(html, /What blocks a random client/i);
  assert.match(html, /Treat model output as untrusted/i);
});

// Every signed-in section is reachable by URL and gated the same way. A route
// that 404s or renders a different chrome is exactly how the interface became
// something you could get lost in.
for (const path of ["/build", "/automation", "/computer", "/setup", "/account"]) {
  test(`server-renders the sign-in gate for ${path}`, async () => {
    const workerUrl = new URL(`../dist/server/index.js?section-test=${encodeURIComponent(path)}-${Date.now()}`, import.meta.url);
    const { default: worker } = await import(workerUrl.href);
    const response = await worker.fetch(new Request(`http://localhost${path}`, { headers: { accept: "text/html" } }), { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } }, { waitUntil() {}, passThroughOnException() {} });
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /Continue securely/);
    assert.match(html, /Owner access code/);
  });
}

test("every page carries the security headers (SEC-13)", async () => {
  const workerUrl = new URL(`../dist/server/index.js?headers-test=${Date.now()}`, import.meta.url);
  const { default: worker } = await import(workerUrl.href);
  for (const path of ["/", "/product", "/pricing"]) {
    const response = await worker.fetch(new Request(`http://localhost${path}`, { headers: { accept: "text/html" } }), { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } }, { waitUntil() {}, passThroughOnException() {} });
    assert.match(response.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/u, path);
    assert.equal(response.headers.get("x-frame-options"), "DENY", path);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff", path);
    assert.equal(response.headers.get("referrer-policy"), "strict-origin-when-cross-origin", path);
  }
});
