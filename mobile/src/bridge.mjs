import { assertNoCredentialsInWebStorage, createSecureStorage } from "./secure-storage.mjs";
import { createDeepLinkHandler } from "./deep-link-handler.mjs";

/**
 * Wires the Capacitor plugins to the Atlas web app.
 *
 * This is the whole reason the shell exists rather than being a bookmark:
 * background push for approvals, biometric re-authentication, credentials in
 * the platform vault, and deep links that open the exact pending decision.
 * A plain WebView delivers none of those, which is why one should not be
 * submitted.
 */
export async function startShell({ plugins, signer, navigate, onPushToken, platform, webStorages = {} }) {
  // Fails loudly at startup rather than leaking quietly for a release or two.
  assertNoCredentialsInWebStorage(webStorages);

  const storage = createSecureStorage({ plugin: plugins.secureStorage, platform });
  const deviceId = await storage.get("atlas.device.credential");

  const handler = createDeepLinkHandler({
    signer,
    deviceId,
    navigate,
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
    plugins.push.addListener("pushNotificationActionPerformed", ({ notification }) => {
      const link = notification?.data?.link;
      if (link) handler.handle(link);
    });
    await plugins.push.register();
  }

  return {
    storage,
    handler,
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
