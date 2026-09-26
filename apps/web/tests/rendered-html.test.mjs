import assert from "node:assert/strict";
import test from "node:test";
test("server-renders the Atlas control plane", async () => {
  const workerUrl = new URL(`../dist/server/index.js?test=${Date.now()}`, import.meta.url);
  const { default: worker } = await import(workerUrl.href);
  const response = await worker.fetch(new Request("http://localhost/", { headers: { accept: "text/html" } }), { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } }, { waitUntil() {}, passThroughOnException() {} });
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /Ask it\. Atlas does the work\./);
  assert.match(html, /What Atlas does/);
  assert.match(html, /href="\/about"/);
  assert.match(html, /Continue with GitHub/);
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
  assert.match(html, /set as the owner of this Atlas deployment/i);
  assert.match(html, /Continue with GitHub/i);
  assert.doesNotMatch(html, /ATLAS_OPERATOR_TOKEN/);
});

test("server-renders the public investor thesis", async () => {
  const workerUrl = new URL(`../dist/server/index.js?investor-test=${Date.now()}`, import.meta.url);
  const { default: worker } = await import(workerUrl.href);
  const response = await worker.fetch(new Request("http://localhost/investors", { headers: { accept: "text/html" } }), { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } }, { waitUntil() {}, passThroughOnException() {} });
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /Where Atlas is headed/i);
  assert.match(html, /From answers.*to finished work/is);
});

test("server-renders an honest parallel mission preview", async () => {
  const workerUrl = new URL(`../dist/server/index.js?parallel-test=${Date.now()}`, import.meta.url);
  const { default: worker } = await import(workerUrl.href);
  const response = await worker.fetch(new Request("http://localhost/product", { headers: { accept: "text/html" } }), { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } }, { waitUntil() {}, passThroughOnException() {} });
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /Several agents on one job/i);
  assert.match(html, /Research child/);
  assert.match(html, /Budget envelope/);
  assert.match(html, /Evidence stream/);
  // Honest labelling: the preview must say it is not live yet.
  assert.match(html, /not live in the hosted app yet/i);
  assert.match(html, /what each agent is doing/i);
});

test("server-renders the login, controls, and self-protection guide", async () => {
  const workerUrl = new URL(`../dist/server/index.js?guide-test=${Date.now()}`, import.meta.url);
  const { default: worker } = await import(workerUrl.href);
  const response = await worker.fetch(new Request("http://localhost/guide", { headers: { accept: "text/html" } }), { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } }, { waitUntil() {}, passThroughOnException() {} });
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /Three ways in/i);
  assert.match(html, /Upgrading your plan raises your limits; it never gives you admin access/is);
  assert.match(html, /What it can.*t do/is);
  assert.match(html, /Merge its own change without every check passing/i);
  assert.match(html, /AI can be wrong or misled/i);
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
    assert.match(html, /Continue with GitHub/);
    assert.match(html, /owner access code/i);
  });
}

test("server-renders the About page with the bio and the shared header", async () => {
  const workerUrl = new URL(`../dist/server/index.js?test=${Date.now()}`, import.meta.url);
  const { default: worker } = await import(workerUrl.href);
  const response = await worker.fetch(new Request("http://localhost/about", { headers: { accept: "text/html" } }), { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } }, { waitUntil() {}, passThroughOnException() {} });
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /Who builds Atlas/);
  assert.match(html, /Why Atlas exists/);
  for (const label of ["Product", "How it works", "Pricing", "Safety", "About"]) assert.match(html, new RegExp(`>${label}<`));
});
