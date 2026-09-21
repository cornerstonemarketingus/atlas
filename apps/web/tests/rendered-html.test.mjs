import assert from "node:assert/strict";
import test from "node:test";
test("server-renders the Atlas control plane", async () => {
  const workerUrl = new URL(`../dist/server/index.js?test=${Date.now()}`, import.meta.url);
  const { default: worker } = await import(workerUrl.href);
  const response = await worker.fetch(new Request("http://localhost/", { headers: { accept: "text/html" } }), { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } }, { waitUntil() {}, passThroughOnException() {} });
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /Give Atlas a goal/);
  assert.match(html, /computer operator/i);
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
  assert.match(html, /unrestricted owner role/i);
  assert.match(html, /Continue with GitHub/i);
  assert.doesNotMatch(html, /ATLAS_OPERATOR_TOKEN/);
});

test("server-renders the public investor thesis", async () => {
  const workerUrl = new URL(`../dist/server/index.js?investor-test=${Date.now()}`, import.meta.url);
  const { default: worker } = await import(workerUrl.href);
  const response = await worker.fetch(new Request("http://localhost/investors", { headers: { accept: "text/html" } }), { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } }, { waitUntil() {}, passThroughOnException() {} });
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /operating system for autonomous product creation/i);
  assert.match(html, /ideas.*become operating products/is);
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
