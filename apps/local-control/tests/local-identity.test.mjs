import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { OWNER_TOKEN_NAME, openInBrowser, ownerAccount, resolveOwnerToken, signInUrl, vaultUsable } from "../src/identity/owner.mjs";

function memoryVault(backend = "keychain", { failSet = false, dropWrites = false } = {}) {
  const values = new Map();
  return {
    backend, values,
    async get(name) { return values.get(name) ?? null; },
    async set(name, value) { if (failSet) throw new Error("keyring locked"); if (!dropWrites) values.set(name, value); },
  };
}

const withDirectory = async (run) => {
  const directory = mkdtempSync(join(tmpdir(), "atlas-identity-"));
  try { await run(directory); } finally { rmSync(directory, { recursive: true, force: true }); }
};
const env = { DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus" };

test("a new owner token goes into the OS vault, and the same token comes back next time", () => withDirectory(async (directory) => {
  const vault = memoryVault();
  const first = await resolveOwnerToken({ dataDirectory: directory, vault, env, os: "darwin" });
  assert.equal(first.storage, "keychain");
  assert.equal(first.created, true);
  assert.ok(first.token.length >= 43);
  assert.equal(vault.values.get(OWNER_TOKEN_NAME), first.token);
  assert.equal(existsSync(join(directory, "local-token")), false, "no plaintext copy");
  const again = await resolveOwnerToken({ dataDirectory: directory, vault, env, os: "darwin" });
  assert.deepEqual(again, { token: first.token, storage: "keychain", created: false });
}));

test("an existing token file moves into the vault unchanged", () => withDirectory(async (directory) => {
  writeFileSync(join(directory, "local-token"), "existing-owner-token-0123456789abcdefghijk\n");
  const vault = memoryVault("dpapi");
  const logs = [];
  const result = await resolveOwnerToken({ dataDirectory: directory, vault, env, os: "win32", log: (line) => logs.push(line) });
  assert.deepEqual(result, { token: "existing-owner-token-0123456789abcdefghijk", storage: "dpapi", created: false });
  assert.equal(existsSync(join(directory, "local-token")), false);
  assert.match(logs.join(" "), /dpapi vault/u);
}));

test("a locked or forgetful keyring falls back to the private file without losing the token", () => withDirectory(async (directory) => {
  const locked = await resolveOwnerToken({ dataDirectory: directory, vault: memoryVault("libsecret", { failSet: true }), env, os: "linux" });
  assert.equal(locked.storage, "file");
  assert.equal(readFileSync(join(directory, "local-token"), "utf8").trim(), locked.token);
  if (process.platform !== "win32") assert.equal(statSync(join(directory, "local-token")).mode & 0o777, 0o600);
  // A vault that accepts but does not keep the value is not trusted, and the file stays.
  const forgetful = await resolveOwnerToken({ dataDirectory: directory, vault: memoryVault("libsecret", { dropWrites: true }), env, os: "linux" });
  assert.deepEqual(forgetful, { token: locked.token, storage: "file", created: false });
  assert.ok(existsSync(join(directory, "local-token")));
}));

test("the environment token and the file override win, and headless Linux skips the keyring", () => withDirectory(async (directory) => {
  const vault = memoryVault("libsecret");
  assert.deepEqual(await resolveOwnerToken({ dataDirectory: directory, vault, env: { ...env, ATLAS_LOCAL_TOKEN: "from-env" }, os: "linux" }), { token: "from-env", storage: "environment", created: false });
  assert.equal(vaultUsable({ vault, env: { ...env, ATLAS_OWNER_TOKEN_STORAGE: "file" }, os: "linux" }), false);
  assert.equal(vaultUsable({ vault, env: {}, os: "linux" }), false);
  assert.equal(vaultUsable({ vault, env: {}, os: "win32" }), true);
  assert.equal(vaultUsable({ vault: memoryVault("file"), env, os: "linux" }), false);
  const headless = await resolveOwnerToken({ dataDirectory: directory, vault, env: {}, os: "linux" });
  assert.equal(headless.storage, "file");
  assert.equal(vault.values.size, 0);
}));

test("sign-in links carry the token only in the fragment, and the browser opens without a shell", () => {
  const url = signInUrl("http://127.0.0.1:4317/", "abc_DEF-123");
  assert.equal(url, "http://127.0.0.1:4317/#signin=abc_DEF-123");
  assert.equal(new URL(url).search, "");
  const calls = [];
  const spawnImpl = (command, args, options) => { calls.push({ command, args, options }); return { on() {}, unref() {} }; };
  assert.equal(openInBrowser(url, { os: "win32", spawnImpl }), true);
  assert.equal(openInBrowser(url, { os: "darwin", spawnImpl }), true);
  assert.equal(openInBrowser(url, { os: "linux", spawnImpl }), true);
  assert.deepEqual(calls.map((call) => call.command), ["rundll32", "open", "xdg-open"]);
  assert.ok(calls.every((call) => call.options.shell === false && call.args.at(-1) === url));
  assert.equal(openInBrowser(url, { os: "linux", spawnImpl: () => { throw new Error("no browser"); } }), false);
  const account = ownerAccount({ info: { username: "sam" }, host: "desk", os: "linux" });
  assert.deepEqual(account, { kind: "os-account", user: "sam", host: "desk", platform: "linux" });
});

test("/v1/identity names the OS account for the owner and never asks for GitHub", async (t) => {
  const { createLocalControlServer } = await import("../src/server.mjs");
  const { LocalTaskStore } = await import("../src/store.mjs");
  const directory = mkdtempSync(join(tmpdir(), "atlas-identity-http-"));
  const store = new LocalTaskStore(join(directory, "test.sqlite"));
  const TOKEN = "0123456789abcdef0123456789abcdef";
  const server = createLocalControlServer({ store, token: TOKEN, runTask: async () => ({ ok: true, message: "" }), identity: { owner: { kind: "os-account", user: "sam", host: "desk", platform: "linux" }, tokenStorage: "libsecret" } });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { await new Promise((resolve) => server.close(resolve)); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${origin}/v1/identity`)).status, 401);
  const owner = await (await fetch(`${origin}/v1/identity`, { headers: { authorization: `Bearer ${TOKEN}` } })).json();
  assert.deepEqual(owner, { role: "owner", account: { kind: "os-account", user: "sam", host: "desk", platform: "linux" }, tokenStorage: "libsecret", requiresGitHub: false });
  const { code } = await (await fetch(`${origin}/v1/pair`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}` } })).json();
  const { deviceToken } = await (await fetch(`${origin}/v1/pair/claim`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, name: "Phone" }) })).json();
  const device = await (await fetch(`${origin}/v1/identity`, { headers: { authorization: `Bearer ${deviceToken}` } })).json();
  assert.equal(device.role, "device");
  assert.equal(device.device.name, "Phone");
  assert.equal(device.account, undefined, "a device does not learn the OS account name");
});
