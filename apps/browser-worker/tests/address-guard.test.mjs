import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import test from "node:test";

import { createGuardedLookup, explicitlyPrivateHosts, privateAddressReason, PRIVATE_DESTINATION } from "../src/address-guard.mjs";
import { startEgressProxy } from "../src/egress-proxy.mjs";

/** A dns.lookup stand-in: every name resolves to the given addresses. */
const resolver = (...addresses) => (hostname, options, callback) =>
  callback(null, addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 })));

function lookupWith(guarded, hostname, options = {}) {
  return new Promise((resolve) => guarded(hostname, options, (error, address, family) => resolve({ error, address, family })));
}

test("classifies private, metadata and encoded addresses", () => {
  for (const ip of ["127.0.0.1", "10.0.0.1", "169.254.169.254", "100.64.0.1", "::1", "::ffff:127.0.0.1", "fd00::1", "fe80::1", "0.0.0.0", "224.0.0.1", "2130706433", "0x7f.1"]) {
    assert.ok(privateAddressReason(ip), ip);
  }
  assert.equal(privateAddressReason("93.184.215.14"), null);
});

test("the guarded lookup refuses any private answer unless the host was named explicitly", async () => {
  const guarded = createGuardedLookup({ lookup: resolver("93.184.215.14", "10.0.0.5") });
  const refused = await lookupWith(guarded, "shop.example");
  assert.equal(refused.error?.code, PRIVATE_DESTINATION);

  const publicOnly = createGuardedLookup({ lookup: resolver("93.184.215.14") });
  assert.deepEqual(await lookupWith(publicOnly, "shop.example"), { error: null, address: "93.184.215.14", family: 4 });

  const permitted = createGuardedLookup({ permittedHosts: new Set(["dev.test"]), lookup: resolver("127.0.0.1") });
  assert.equal((await lookupWith(permitted, "dev.test")).address, "127.0.0.1");
  assert.equal((await lookupWith(permitted, "other.test")).error?.code, PRIVATE_DESTINATION);
});

test("explicit private hosts are IP-literal and localhost origins plus the env list", () => {
  const hosts = explicitlyPrivateHosts(new Set(["http://127.0.0.1:8080", "https://shop.example", "http://localhost:3000"]), "intranet.test");
  assert.deepEqual([...hosts].sort(), ["127.0.0.1", "intranet.test", "localhost"]);
});

async function fixture(t) {
  const server = createServer((req, res) => res.end("internal secret"));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return server.address().port;
}

async function proxyFor(t, options) {
  const blocked = [];
  const proxy = await startEgressProxy({ onBlocked: (url, kind) => blocked.push({ url, kind }), ...options });
  t.after(() => proxy.close());
  const { port } = new URL(proxy.server);
  return { port, blocked };
}

function viaProxy(proxyPort, target) {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: proxyPort, path: target, headers: { host: new URL(target).host } }, (res) => {
      let body = "";
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

function connectViaProxy(proxyPort, authority) {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: proxyPort, method: "CONNECT", path: authority });
    req.on("connect", (res, socket) => { socket.destroy(); resolve(res.statusCode); });
    req.on("response", (res) => resolve(res.statusCode));
    req.on("error", reject);
    req.end();
  });
}

test("DNS rebinding: an allowed hostname that resolves to loopback is blocked at connect time", async (t) => {
  const port = await fixture(t);
  const origin = `http://rebind.test:${port}`;
  const { port: proxyPort, blocked } = await proxyFor(t, { allowedOrigins: new Set([origin]), lookup: resolver("127.0.0.1"), allowPrivateHosts: "" });
  const response = await viaProxy(proxyPort, `${origin}/`);
  assert.equal(response.status, 403);
  assert.doesNotMatch(response.body, /internal secret/u);
  assert.equal(blocked.at(-1).kind, "proxy-address");
  assert.equal(await connectViaProxy(proxyPort, `rebind.test:${port}`), 403);
});

test("an explicitly listed private origin still works (the 127.0.0.1 test fixtures)", async (t) => {
  const port = await fixture(t);
  const origin = `http://127.0.0.1:${port}`;
  const { port: proxyPort } = await proxyFor(t, { allowedOrigins: new Set([origin]), allowPrivateHosts: "" });
  const response = await viaProxy(proxyPort, `${origin}/`);
  assert.equal(response.status, 200);
  assert.equal(response.body, "internal secret");
});

test("the operator can opt a private hostname in, via the list or allowPrivateNetwork", async (t) => {
  const port = await fixture(t);
  const origin = `http://dev.test:${port}`;
  const listed = await proxyFor(t, { allowedOrigins: new Set([origin]), lookup: resolver("127.0.0.1"), allowPrivateHosts: "dev.test" });
  assert.equal((await viaProxy(listed.port, `${origin}/`)).status, 200);
  const network = await proxyFor(t, { allowedOrigins: new Set([origin]), lookup: resolver("127.0.0.1"), allowPrivateHosts: "", allowPrivateNetwork: true });
  assert.equal((await viaProxy(network.port, `${origin}/`)).status, 200);
});
