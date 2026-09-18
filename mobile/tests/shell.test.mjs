import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { createSecureStorage, assertNoCredentialsInWebStorage, SecureStorageError, CREDENTIAL_KEYS } from "../src/secure-storage.mjs";
import { createDeepLinkHandler } from "../src/deep-link-handler.mjs";
import { startShell } from "../src/bridge.mjs";
import { createDeepLinkSigner } from "../../apps/local-control/src/mobile/deep-links.mjs";

const SECRET = "0123456789abcdef0123456789abcdef0123456789";

/** A stand-in for the Keychain/Keystore plugin. */
function vaultPlugin() {
  const values = new Map();
  return {
    values,
    async set({ key, value }) { values.set(key, value); },
    async get({ key }) { if (!values.has(key)) throw new Error("not found"); return { value: values.get(key) }; },
    async remove({ key }) { values.delete(key); },
  };
}

/** A minimal Storage-like object, as a WebView would provide. */
function webStorage(entries) {
  const keys = Object.keys(entries);
  return { length: keys.length, key: (index) => keys[index] ?? null, getItem: (key) => entries[key] ?? null };
}

test("device credentials go to the platform vault and never to web storage", async () => {
  const plugin = vaultPlugin();
  const storage = createSecureStorage({ plugin, platform: "ios" });

  await storage.set("atlas.device.credential", "device-secret-value");
  assert.equal(await storage.get("atlas.device.credential"), "device-secret-value");
  assert.equal(plugin.values.get("atlas.device.credential"), "device-secret-value");

  // Missing is a normal state, not an exception the app has to handle.
  assert.equal(await storage.get("atlas.push.token"), null);

  await storage.remove("atlas.device.credential");
  assert.equal(await storage.get("atlas.device.credential"), null);

  await assert.rejects(() => storage.set("something.else", "x"), SecureStorageError);
  await assert.rejects(() => storage.set("atlas.push.token", ""), /cannot be empty/u);
});

test("there is no fallback to browser storage when the vault is unavailable", () => {
  // A fallback is exactly how this rule gets quietly broken, so the shell
  // refuses to start instead.
  assert.throws(() => createSecureStorage({ plugin: null, platform: "android" }), (error) => error.code === "NO_SECURE_STORAGE");
  assert.throws(() => createSecureStorage({ plugin: null, platform: "ios" }), /will not fall back to browser storage/u);
});

test("a credential found in web storage stops the app at startup", () => {
  assert.doesNotThrow(() => assertNoCredentialsInWebStorage({ localStorage: webStorage({ "atlas-theme": "dark", "atlas-session": "ui-state" }) }));

  for (const key of [...CREDENTIAL_KEYS, "deviceToken", "atlas_push_token", "myCredential"]) {
    assert.throws(
      () => assertNoCredentialsInWebStorage({ localStorage: webStorage({ [key]: "value" }) }),
      (error) => error.code === "CREDENTIAL_IN_WEB_STORAGE",
      `${key} must be caught`,
    );
  }
  assert.throws(() => assertNoCredentialsInWebStorage({ sessionStorage: webStorage({ "atlas.device.credential": "x" }) }), /web storage/u);
});

test("a deep link is verified before anything is opened, and is spent on use", async () => {
  const signer = createDeepLinkSigner({ secret: SECRET });
  const id = randomUUID();
  const link = signer.create({ target: "approval", id, deviceId: "phone-1" });

  const opened = [];
  const rejected = [];
  const handler = createDeepLinkHandler({
    signer,
    deviceId: "phone-1",
    navigate: async (screen) => { opened.push(screen); },
    onRejected: (info) => rejected.push(info),
  });

  const first = await handler.handle(link.appLink);
  assert.equal(first.opened, true);
  assert.deepEqual(opened, [{ screen: "approval", id }]);

  // Forwarding the notification to someone else does not work.
  const second = await handler.handle(link.appLink);
  assert.equal(second.opened, false);
  assert.match(second.reason, /already been used/u);
  assert.equal(opened.length, 1, "nothing was navigated to on the second attempt");
  assert.equal(rejected.length, 1, "the operator is told why it did not open");

  const forged = await handler.handle(link.appLink.replace(id, randomUUID()));
  assert.equal(forged.opened, false);
  assert.equal(opened.length, 1);
});

test("the shell registers for push, handles a tapped notification, and can revoke itself", async () => {
  const signer = createDeepLinkSigner({ secret: SECRET });
  const plugin = vaultPlugin();
  await plugin.set({ key: "atlas.device.credential", value: "phone-1" });

  const listeners = new Map();
  const navigated = [];
  let registered = false;
  let unregistered = false;
  const tokens = [];

  const shell = await startShell({
    platform: "ios",
    signer,
    navigate: async (screen) => { navigated.push(screen); },
    onPushToken: async ({ token }) => { tokens.push(token); },
    webStorages: { localStorage: webStorage({ "atlas-theme": "dark" }) },
    plugins: {
      secureStorage: plugin,
      app: { addListener: (name, handler) => listeners.set(name, handler) },
      push: {
        requestPermissions: async () => ({ receive: "granted" }),
        addListener: (name, handler) => listeners.set(name, handler),
        register: async () => { registered = true; },
        unregister: async () => { unregistered = true; },
      },
      biometrics: { verifyIdentity: async () => true },
    },
  });

  assert.equal(registered, true, "the shell registered for background push");

  await listeners.get("registration")({ value: "apns-token-value" });
  assert.deepEqual(tokens, ["apns-token-value"]);
  assert.equal(plugin.values.get("atlas.push.token"), "apns-token-value", "the push token is in the vault, not web storage");

  // A tapped notification goes through the same verification as any link.
  const id = randomUUID();
  const link = signer.create({ target: "approval", id, deviceId: "phone-1" });
  await listeners.get("pushNotificationActionPerformed")({ notification: { data: { link: link.appLink } } });
  assert.deepEqual(navigated, [{ screen: "approval", id }]);

  // A forged notification opens nothing.
  await listeners.get("pushNotificationActionPerformed")({ notification: { data: { link: "atlas://approval?id=x&s=forged" } } });
  assert.equal(navigated.length, 1);

  const identity = await shell.verifyIdentity({ reason: "Approve sending this email" });
  assert.equal(identity.verified, true);
  assert.ok(identity.at > 0);

  // A lost device is cut off completely: no token, no credential, no push.
  await shell.revoke();
  assert.equal(unregistered, true);
  assert.equal(plugin.values.size, 0, "every credential was cleared");
});

test("a shell with no biometric hardware reports it instead of pretending", async () => {
  const plugin = vaultPlugin();
  const shell = await startShell({
    platform: "android",
    signer: createDeepLinkSigner({ secret: SECRET }),
    navigate: async () => {},
    plugins: { secureStorage: plugin, push: { requestPermissions: async () => ({ receive: "denied" }) } },
  });
  const identity = await shell.verifyIdentity({ reason: "Approve" });
  assert.equal(identity.verified, false);
  assert.match(identity.reason, /no biometric hardware/u);
});

test("the Capacitor configuration does not weaken transport security", async () => {
  const { readFile } = await import("node:fs/promises");
  const { dirname, join } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const config = JSON.parse(await readFile(join(root, "capacitor.config.json"), "utf8"));

  assert.equal(config.server.cleartext, false, "the shell never talks plain HTTP over a network");
  assert.equal(config.android.allowMixedContent, false);
  assert.equal(config.ios.limitsNavigationsToAppBoundDomains, true, "the WebView cannot be navigated off Atlas");
  assert.equal(config.server.androidScheme, "https");
  assert.equal(config.appId, "com.cornerstonemarketingus.atlas");
});
