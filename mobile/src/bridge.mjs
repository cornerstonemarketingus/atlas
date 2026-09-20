import { assertNoCredentialsInWebStorage, createSecureStorage } from "./secure-storage.mjs";
import { createDeepLinkHandler } from "./deep-link-handler.mjs";
import { createSpentNonceLedger } from "./spent-nonces.mjs";

/**
 * Wires the Capacitor plugins to the Atlas web app.
 *
 * This is the whole reason the shell exists rather than being a bookmark:
 * background push for approvals, biometric re-authentication, credentials in
 * the platform vault, and deep links that open the exact pending decision.
 * A plain WebView delivers none of those, which is why one should not be
 * submitted.
 */
export async function startShell({ plugins, signer, navigate, onPushToken, platform, webStorages = {}, onLedgerError }) {
  // Fails loudly at startup rather than leaking quietly for a release or two.
  assertNoCredentialsInWebStorage(webStorages);

  const storage = createSecureStorage({ plugin: plugins.secureStorage, platform });
  const deviceId = await storage.get("atlas.device.credential");

  // Which approval links have already been opened, read back from the last
  // run. Ordinary preference storage: a nonce is not a secret, and a link's
  // authority comes from its signature.
  const spentNonces = createSpentNonceLedger({
    storage: plugins.preferences,
    onError: ({ stage, error }) => {
      onLedgerError?.({ stage, error });
      plugins.toast?.show?.({ text: "Atlas could not read which approval links have already been used." });
    },
  });
  // Awaited before any link is handled: an unloaded ledger looks empty, and
  // an empty ledger accepts the replay this exists to stop.
  await spentNonces.load();

  const handler = createDeepLinkHandler({
    signer,
    deviceId,
    navigate,
    spentNonces,
    onRejected: ({ reason }) => plugins.toast?.show?.({ text: reason }),
  });
  plugins.app?.addListener?.("appUrlOpen", (event) => handler.handle(event.url));

  const permission = await plugins.push?.requestPermissions?.();
  if (permission?.receive === "granted") {
    plugins.push.addListener("registration", async ({ value }) => {
      await storage.set("atlas.push.token", value);
      await onPushToken?.({ token: value, platform });
    });
    // A tapped notification carries the same signed link, so it goes through
    // the same verification as one opened from anywhere else.
    // The promise is returned rather than dropped. Handling a link now writes
    // the spent-nonce ledger before it navigates, so a caller that wants to
    // know the link was dealt with has something to wait on.
    plugins.push.addListener("pushNotificationActionPerformed", ({ notification }) => {
      const link = notification?.data?.link;
      return link ? handler.handle(link) : Promise.resolve({ opened: false, reason: "That notification carried no link." });
    });
    await plugins.push.register();
  }

  return {
    storage,
    handler,
    spentNonces,
    /** Called when the daemon reports this device revoked. */
    async revoke() {
      await plugins.push?.unregister?.().catch(() => {});
      await storage.clearAll();
    },
    async verifyIdentity({ reason }) {
      if (!plugins.biometrics) return { verified: false, reason: "This device has no biometric hardware available to Atlas." };
      try {
        await plugins.biometrics.verifyIdentity({ reason, title: "Atlas", subtitle: reason });
        return { verified: true, at: Date.now() };
      } catch (error) {
        return { verified: false, reason: error?.message ?? "Re-authentication was cancelled." };
      }
    },
  };
}
