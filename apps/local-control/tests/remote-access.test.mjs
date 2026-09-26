import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { RemoteAccess, assertRemoteUrl, createRemoteRoutes, isRemoteRequest, proxyGuides } from "../src/remote/access.mjs";
import { createLocalControlServer } from "../src/server.mjs";
import { LocalTaskStore } from "../src/store.mjs";

const TOKEN = "0123456789abcdef0123456789abcdef";

function fakeTailscale({ installed = true, state = "Running", serving = false, refuse = false } = {}) {
  const calls = [];
  const runCommandImpl = async (command, args) => {
    calls.push([command, ...args]);
    if (!installed) return { ok: false, stdout: "", stderr: "spawn tailscale ENOENT" };
    if (args[0] === "status") return { ok: true, stdout: JSON.stringify({ BackendState: state, Self: { DNSName: "desk.tail1234.ts.net.", TailscaleIPs: ["100.64.0.7"] } }) };
    if (args[0] === "serve" && args[1] === "status") return { ok: true, stdout: serving ? JSON.stringify({ Web: { "desk.tail1234.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:4317" } } } } }) : "{}" };
    if (args[0] === "serve" && args[1] === "--bg") { if (refuse) return { ok: false, stdout: "", stderr: "Access denied: serve config denied" }; serving = true; return { ok: true, stdout: "" }; }
    if (args[0] === "serve" && args.at(-1) === "off") { serving = false; return { ok: true, stdout: "" }; }
    return { ok: false, stdout: "", stderr: "unexpected" };
  };
  return { calls, runCommandImpl };
}

const withDirectory = async (run) => {
  const directory = mkdtempSync(join(tmpdir(), "atlas-remote-"));
  try { await run(directory); } finally { rmSync(directory, { recursive: true, force: true }); }
};

test("remote requests are recognised by proxy headers or a non-loopback peer", () => {
  assert.equal(isRemoteRequest({ headers: {}, socket: { remoteAddress: "127.0.0.1" } }), false);
  assert.equal(isRemoteRequest({ headers: {}, socket: { remoteAddress: "::ffff:127.0.0.1" } }), false);
  assert.equal(isRemoteRequest({ headers: { "x-forwarded-for": "100.64.0.9" }, socket: { remoteAddress: "127.0.0.1" } }), true);
  assert.equal(isRemoteRequest({ headers: { "tailscale-user-login": "me@example.com" }, socket: { remoteAddress: "127.0.0.1" } }), true);
  assert.equal(isRemoteRequest({ headers: {}, socket: { remoteAddress: "192.168.1.20" } }), true);
});

test("only a clean HTTPS origin is accepted as a remote address, and guides point at loopback", () => {
  assert.equal(assertRemoteUrl("https://atlas.example.com/"), "https://atlas.example.com");
  for (const bad of ["http://atlas.example.com", "https://me:pw@atlas.example.com", "https://atlas.example.com/app", "atlas", "https://x.example?y=1"]) {
    assert.throws(() => assertRemoteUrl(bad), (error) => error.code === "INVALID_URL", bad);
  }
  const guides = proxyGuides({ port: 4317, hostname: "atlas.example.com" });
  assert.match(guides.caddy, /atlas\.example\.com \{\n\treverse_proxy 127\.0\.0\.1:4317/u);
  assert.match(guides.nginx, /proxy_pass http:\/\/127\.0\.0\.1:4317;/u);
  assert.equal(guides.tailscale, "tailscale serve --bg --https=443 http://127.0.0.1:4317");
  assert.doesNotMatch(JSON.stringify(guides), /funnel/u, "never exposes Atlas to the public internet");
});

test("Tailscale serve is enabled on the tailnet, reported, and turned off again", () => withDirectory(async (directory) => {
  const tailscale = fakeTailscale();
  const remote = new RemoteAccess({ port: 4317, settingsPath: join(directory, "remote.json"), runCommandImpl: tailscale.runCommandImpl });
  const before = await remote.status();
  assert.equal(before.settings.mode, "off");
  assert.equal(before.tailscale.running, true);
  assert.equal(before.tailscale.serving, false);
  const enabled = await remote.enableTailscale();
  assert.deepEqual(tailscale.calls.find((call) => call[2] === "--bg"), ["tailscale", "serve", "--bg", "--https=443", "http://127.0.0.1:4317"]);
  assert.equal(enabled.tailscale.url, "https://desk.tail1234.ts.net");
  assert.deepEqual({ mode: enabled.settings.mode, url: enabled.settings.url }, { mode: "tailscale", url: "https://desk.tail1234.ts.net" });
  assert.ok(!tailscale.calls.some((call) => call.includes("funnel")));
  remote.setOwnerRemote(true);
  assert.equal(remote.ownerAllowedRemotely(), true);
  const off = await remote.disable();
  assert.equal(off.settings.mode, "off");
  assert.equal(off.settings.ownerRemote, false, "turning remote access off also withdraws owner access");
  assert.equal(off.tailscale.serving, false);
}));

test("missing, stopped or refusing Tailscale explains what to do", () => withDirectory(async (directory) => {
  const settingsPath = join(directory, "remote.json");
  await assert.rejects(new RemoteAccess({ port: 4317, settingsPath, runCommandImpl: fakeTailscale({ installed: false }).runCommandImpl }).enableTailscale(), (error) => error.code === "NO_TAILSCALE");
  await assert.rejects(new RemoteAccess({ port: 4317, settingsPath, runCommandImpl: fakeTailscale({ state: "NeedsLogin" }).runCommandImpl }).enableTailscale(), (error) => error.code === "TAILSCALE_STOPPED" && /needslogin/u.test(error.message));
  await assert.rejects(new RemoteAccess({ port: 4317, settingsPath, runCommandImpl: fakeTailscale({ refuse: true }).runCommandImpl }).enableTailscale(), (error) => error.code === "TAILSCALE_REFUSED" && error.message.includes("tailscale serve --bg"));
  assert.throws(() => new RemoteAccess({ port: 4317, settingsPath, runCommandImpl: fakeTailscale().runCommandImpl }).setOwnerRemote(true), (error) => error.code === "REMOTE_OFF");
}));

test("an owner-managed HTTPS proxy is recorded and checked", () => withDirectory(async (directory) => {
  const fetchImpl = async (url) => (String(url) === "https://atlas.example.com/health" ? new Response(JSON.stringify({ status: "ok", mode: "sovereign" })) : new Response("", { status: 502 }));
  const remote = new RemoteAccess({ port: 4317, settingsPath: join(directory, "remote.json"), runCommandImpl: fakeTailscale({ installed: false }).runCommandImpl, fetchImpl });
  const ok = await remote.useProxy("https://atlas.example.com");
  assert.equal(ok.check.reachable, true);
  assert.deepEqual({ mode: ok.settings.mode, url: ok.settings.url }, { mode: "proxy", url: "https://atlas.example.com" });
  assert.match(ok.guides.caddy, /^atlas\.example\.com /u);
  const unreachable = await remote.useProxy("https://other.example.com");
  assert.equal(unreachable.check.reachable, false);
  await assert.rejects(remote.useProxy("http://plain.example.com"), (error) => error.code === "INVALID_URL");
}));

test("over a proxy the owner token is refused unless allowed; paired devices work; /v1/remote is owner-only", async (t) => {
  // Cleanup order matters on Windows: the server and database close before the directory is removed.
  const directory = mkdtempSync(join(tmpdir(), "atlas-remote-http-"));
  const store = new LocalTaskStore(join(directory, "test.sqlite"));
  const remoteAccess = new RemoteAccess({ port: 4317, settingsPath: join(directory, "remote.json"), runCommandImpl: fakeTailscale().runCommandImpl });
  const server = createLocalControlServer({ store, token: TOKEN, runTask: async () => ({ ok: true, message: "" }), remoteAccess });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections?.(); await new Promise((resolve) => server.close(resolve)); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const owner = { authorization: `Bearer ${TOKEN}` };
  const proxied = { "x-forwarded-for": "100.64.0.9" };

  assert.equal((await fetch(`${origin}/v1/tasks`, { headers: owner })).status, 200, "the owner token works on this computer");
  const refused = await fetch(`${origin}/v1/tasks`, { headers: { ...owner, ...proxied } });
  assert.equal(refused.status, 403);
  assert.match((await refused.json()).unblock, /Pair this device/u);

  const { code } = await (await fetch(`${origin}/v1/pair`, { method: "POST", headers: owner })).json();
  const claim = await fetch(`${origin}/v1/pair/claim`, { method: "POST", headers: { "content-type": "application/json", ...proxied }, body: JSON.stringify({ code, name: "Phone" }) });
  assert.equal(claim.status, 201, "a phone pairs through the proxy");
  const { deviceToken } = await claim.json();
  assert.equal((await fetch(`${origin}/v1/approvals`, { headers: { authorization: `Bearer ${deviceToken}`, ...proxied } })).status, 200);
  assert.equal((await fetch(`${origin}/v1/remote`, { headers: { authorization: `Bearer ${deviceToken}` } })).status, 403);

  const status = await (await fetch(`${origin}/v1/remote`, { headers: owner })).json();
  assert.equal(status.listening, "127.0.0.1:4317");
  const handle = createRemoteRoutes({ remote: remoteAccess, parseBody: async (request) => request.body, send: (response, statusCode, value) => { response.status = statusCode; response.body = value; return true; } });
  const enable = {};
  await handle({ method: "POST", url: "/v1/remote/tailscale", body: { action: "enable" } }, enable, { role: "admin" });
  assert.equal(enable.status, 200);
  const allow = {};
  await handle({ method: "POST", url: "/v1/remote/owner", body: { allow: true } }, allow, { role: "admin" });
  assert.equal(allow.body.settings.ownerRemote, true);
  assert.equal((await fetch(`${origin}/v1/tasks`, { headers: { ...owner, ...proxied } })).status, 200, "the owner chose to allow it");
});
