import assert from "node:assert/strict";
import test from "node:test";

import {
  assertPublicDestination,
  createDestinationChecker,
  isPrivateAddress,
  literalHostReason,
  parseAllowList,
  parseIPv4,
  privateAddressReason,
  UnsafeDestinationError,
} from "../src/net/ssrf-guard.mjs";
import { ToolRegistry } from "../src/agent/tool-registry.mjs";
import { registerBrowserTools } from "../src/agent/tools/browser-tools.mjs";
import { createPlaywrightPage, UnsafeNavigationError } from "../src/agent/browser/playwright-page.mjs";

const publicLookup = async () => [{ address: "93.184.215.14", family: 4 }];
const resolvesTo = (...addresses) => async () => addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));

test("private, loopback, link-local, CGNAT, multicast and reserved addresses are classified as private", () => {
  for (const ip of [
    "127.0.0.1", "127.255.255.254", "10.0.0.1", "172.16.0.1", "172.31.255.255", "192.168.1.1",
    "169.254.169.254", "100.64.0.1", "100.127.255.255", "0.0.0.0", "0.1.2.3", "224.0.0.1", "239.255.255.250",
    "255.255.255.255", "198.18.0.1", "192.0.0.170",
    "::1", "::", "fc00::1", "fd12:3456::1", "fe80::1", "fe80::1%eth0", "ff02::1",
    "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:169.254.169.254", "::ffff:a9fe:a9fe", "::127.0.0.1",
    "64:ff9b::10.0.0.1", "2002:c0a8:0101::1",
  ]) {
    assert.equal(isPrivateAddress(ip), true, `${ip} must be private`);
  }
  for (const ip of ["8.8.8.8", "1.1.1.1", "93.184.215.14", "172.32.0.1", "100.128.0.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"]) {
    assert.equal(isPrivateAddress(ip), false, `${ip} is public`);
  }
  assert.equal(privateAddressReason("example.com"), undefined, "a hostname is not an address");
});

test("decimal, octal, hex and shorthand IPv4 encodings all decode to the address they name", () => {
  const loopback = parseIPv4("127.0.0.1");
  for (const encoded of ["2130706433", "0x7f000001", "0x7f.1", "0177.0.0.1", "017700000001", "127.1", "127.0.1", "0x7F.0.0.0x1"]) {
    assert.equal(parseIPv4(encoded), loopback, encoded);
    assert.equal(literalHostReason(encoded), "loopback", encoded);
  }
  assert.equal(parseIPv4("0xa9fea9fe"), parseIPv4("169.254.169.254"));
  assert.equal(parseIPv4("256.1.1.1"), null);
  assert.equal(parseIPv4("1.2.3.4.5"), null);
  assert.equal(parseIPv4("example"), null);
});

test("local names are refused without a lookup", () => {
  for (const host of ["localhost", "LOCALHOST.", "api.localhost", "printer.local", "metadata.google.internal", "router", "nas.lan", "[::1]"]) {
    assert.ok(literalHostReason(host), `${host} must be refused`);
  }
  assert.equal(literalHostReason("example.com"), null);
});

test("URLs in every encoding of a private address are refused before any lookup", async () => {
  let lookups = 0;
  const lookup = async () => { lookups += 1; return [{ address: "93.184.215.14", family: 4 }]; };
  for (const url of [
    "http://127.0.0.1:4317/v1/state", "http://localhost:4317/", "http://2130706433/", "http://0x7f.1/", "http://0177.0.0.1/",
    "http://127.1/", "http://[::1]/", "http://[::ffff:127.0.0.1]/", "http://[::ffff:a9fe:a9fe]/latest/meta-data/",
    "http://169.254.169.254/latest/meta-data/", "http://10.0.0.1/", "http://192.168.0.1/admin", "http://100.64.1.1/",
    "http://[fd00::1]/", "http://[fe80::1]/", "http://0.0.0.0:4317/", "http://224.0.0.1/", "http://metadata.google.internal/",
  ]) {
    await assert.rejects(() => assertPublicDestination(url, { lookup, allowPrivateHosts: "" }),
      (error) => error instanceof UnsafeDestinationError && error.code === "PRIVATE_DESTINATION", url);
  }
  assert.equal(lookups, 0, "literal checks need no DNS");
});

test("a hostname is refused when any address it resolves to is private", async () => {
  await assert.rejects(() => assertPublicDestination("https://rebind.example/", { lookup: resolvesTo("93.184.215.14", "10.0.0.5"), allowPrivateHosts: "" }), /10\.0\.0\.5/u);
  await assert.rejects(() => assertPublicDestination("https://meta.example/", { lookup: resolvesTo("169.254.169.254"), allowPrivateHosts: "" }), /link-local/u);
  await assert.rejects(() => assertPublicDestination("https://v6.example/", { lookup: resolvesTo("::ffff:127.0.0.1"), allowPrivateHosts: "" }), /loopback/u);
  const ok = await assertPublicDestination("https://example.com/path", { lookup: resolvesTo("93.184.215.14", "2606:2800:21f:cb07:6820:80da:af6b:8b2c"), allowPrivateHosts: "" });
  assert.equal(ok.url, "https://example.com/path");
});

test("a lookup failure is a refusal, not a pass", async () => {
  const failing = async () => { const error = new Error("nope"); error.code = "ENOTFOUND"; throw error; };
  await assert.rejects(() => assertPublicDestination("https://nowhere.example/", { lookup: failing, allowPrivateHosts: "" }), (error) => error.code === "UNRESOLVABLE");
  await assert.rejects(() => assertPublicDestination("https://empty.example/", { lookup: async () => [], allowPrivateHosts: "" }), (error) => error.code === "UNRESOLVABLE");
});

test("the operator allow-list opts specific private hosts in, and nothing else", async () => {
  const allowPrivateHosts = "localhost, dev.example.test, *.corp.test, 10.1.0.0/16, ::1";
  await assertPublicDestination("http://localhost:3000/", { lookup: publicLookup, allowPrivateHosts });
  await assertPublicDestination("http://[::1]:3000/", { lookup: publicLookup, allowPrivateHosts });
  await assertPublicDestination("http://10.1.2.3/", { lookup: publicLookup, allowPrivateHosts });
  await assertPublicDestination("http://wiki.corp.test/", { lookup: resolvesTo("10.9.9.9"), allowPrivateHosts });
  await assertPublicDestination("http://app.example.org/", { lookup: resolvesTo("10.1.4.4"), allowPrivateHosts });
  await assert.rejects(() => assertPublicDestination("http://10.2.0.1/", { lookup: publicLookup, allowPrivateHosts }), /PRIVATE|does not open/u);
  await assert.rejects(() => assertPublicDestination("http://127.0.0.1/", { lookup: publicLookup, allowPrivateHosts }), /does not open/u);
  await assert.rejects(() => assertPublicDestination("http://169.254.169.254/", { lookup: publicLookup, allowPrivateHosts }), /does not open/u);
  assert.equal(parseAllowList("").empty, true);
});

test("the allow-list defaults to ATLAS_BROWSER_ALLOW_PRIVATE_HOSTS", async (t) => {
  const previous = process.env.ATLAS_BROWSER_ALLOW_PRIVATE_HOSTS;
  t.after(() => {
    if (previous === undefined) delete process.env.ATLAS_BROWSER_ALLOW_PRIVATE_HOSTS;
    else process.env.ATLAS_BROWSER_ALLOW_PRIVATE_HOSTS = previous;
  });
  process.env.ATLAS_BROWSER_ALLOW_PRIVATE_HOSTS = "127.0.0.1";
  await assertPublicDestination("http://127.0.0.1:8080/", { lookup: publicLookup });
  delete process.env.ATLAS_BROWSER_ALLOW_PRIVATE_HOSTS;
  await assert.rejects(() => assertPublicDestination("http://127.0.0.1:8080/", { lookup: publicLookup }), /does not open/u);
});

function browserRegistry(session, urlPolicy) {
  const registry = new ToolRegistry({ policy: () => "allow" });
  registerBrowserTools(registry, { session, urlPolicy });
  const approvals = { check: async () => false };
  return (name, args) => registry.invoke({ name, rawArguments: JSON.stringify(args), sessionId: "s1", approvals, context: {} });
}

test("browser.navigate refuses the daemon, the LAN and cloud metadata, and never reaches the browser", async () => {
  const opened = [];
  const session = { navigate: async ({ url }) => { opened.push(url); return { url }; } };
  const run = browserRegistry(session, { lookup: resolvesTo("10.0.0.7"), allowPrivateHosts: "" });
  for (const url of ["http://127.0.0.1:4317/v1/state", "http://localhost:4317/", "http://169.254.169.254/latest/meta-data/", "http://0x7f.1/", "http://[::ffff:127.0.0.1]/", "https://intranet.example/"]) {
    const result = await run("browser.navigate", { url });
    assert.equal(result.status, "failed", url);
    assert.equal(result.code, "PRIVATE_DESTINATION", url);
  }
  assert.deepEqual(opened, []);
});

test("browser.navigate reports a redirect onto a private host as a failure", async () => {
  const session = { navigate: async () => ({ url: "http://169.254.169.254/latest/meta-data/", title: "metadata" }) };
  const run = browserRegistry(session, { lookup: publicLookup, allowPrivateHosts: "" });
  const result = await run("browser.navigate", { url: "https://redirector.example/" });
  assert.equal(result.status, "failed");
  assert.match(result.message, /redirected/u);
  assert.doesNotMatch(result.output ?? "", /metadata/u);
});

test("browser.navigate opens an allow-listed local host", async () => {
  const session = { navigate: async ({ url }) => ({ url, title: "Dev" }) };
  const run = browserRegistry(session, { lookup: publicLookup, allowPrivateHosts: "localhost" });
  const result = await run("browser.navigate", { url: "http://localhost:5173/" });
  assert.equal(result.status, "completed");
});

function fakePlaywright({ redirectTo = null } = {}) {
  const state = { routeHandler: null, url: "about:blank", gotos: [] };
  const page = {
    async goto(url) { state.gotos.push(url); state.url = url === "about:blank" ? url : (redirectTo ?? url); },
    url: () => state.url,
    title: async () => "",
  };
  const context = {
    async route(pattern, handler) { state.routeHandler = handler; },
    pages: () => [page],
    async newPage() { return page; },
    async close() {},
  };
  return { state, importPlaywright: async () => ({ chromium: { launchPersistentContext: async () => context } }) };
}

async function routeVerdict(handler, url) {
  let verdict = null;
  await handler({ request: () => ({ url: () => url }), continue: async () => { verdict = "continue"; }, abort: async (code) => { verdict = `abort:${code}`; } });
  return verdict;
}

test("the Playwright page blocks every private request and clears a redirect landing", async (t) => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const directory = await mkdtemp(join(tmpdir(), "atlas-ssrf-"));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const lookup = async (host) => (host === "evil.example" ? [{ address: "192.168.1.1", family: 4 }] : [{ address: "93.184.215.14", family: 4 }]);
  const fake = fakePlaywright({ redirectTo: "http://169.254.169.254/latest/meta-data/" });
  const page = await createPlaywrightPage({ profileDirectory: join(directory, "profile"), importPlaywright: fake.importPlaywright, urlPolicy: { lookup, allowPrivateHosts: "" } });

  assert.equal(await routeVerdict(fake.state.routeHandler, "https://example.com/app.js"), "continue");
  assert.equal(await routeVerdict(fake.state.routeHandler, "http://127.0.0.1:4317/v1/state"), "abort:blockedbyclient");
  assert.equal(await routeVerdict(fake.state.routeHandler, "https://evil.example/"), "abort:blockedbyclient");
  assert.equal(await routeVerdict(fake.state.routeHandler, "data:text/plain,hi"), "continue");
  assert.equal(page.blockedRequests().length, 2);

  await assert.rejects(() => page.goto({ url: "https://redirector.example/" }), (error) => error instanceof UnsafeNavigationError && /redirected/u.test(error.message));
  assert.equal(fake.state.url, "about:blank", "the private landing page is cleared");
  await assert.rejects(() => page.goto({ url: "http://10.0.0.1/" }), UnsafeNavigationError);
  assert.equal(fake.state.gotos.includes("http://10.0.0.1/"), false, "a private URL is never handed to the browser");
});

test("the cached checker caches both verdicts per host", async () => {
  let lookups = 0;
  const check = createDestinationChecker({ lookup: async () => { lookups += 1; return [{ address: "93.184.215.14", family: 4 }]; }, allowPrivateHosts: "" });
  assert.equal((await check("https://example.com/a")).ok, true);
  assert.equal((await check("https://example.com/b")).ok, true);
  assert.equal(lookups, 1);
  assert.equal((await check("http://127.0.0.1/")).ok, false);
});
