import { App, type URLOpenListenerEvent } from "@capacitor/app";
import { PushNotifications, type ActionPerformed, type Token } from "@capacitor/push-notifications";

const ATLAS_ORIGIN = "https://atlas-web.cornerstonemarketingus.workers.dev";
const SAFE_PATH = /^\/(?:computer|setup|account)(?:\/[^?#]*)?(?:\?[^#]*)?$/u;

export function atlasDeepLink(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (url.protocol === "atlas:" && url.hostname === "open") {
      const path = `${url.pathname}${url.search}`;
      return SAFE_PATH.test(path) ? `${ATLAS_ORIGIN}${path}` : null;
    }
    if (url.origin === ATLAS_ORIGIN) {
      const path = `${url.pathname}${url.search}`;
      return SAFE_PATH.test(path) ? url.toString() : null;
    }
  } catch { /* malformed links are ignored */ }
  return null;
}

export async function initializeNativeBridge(options: {
  navigate: (url: string) => void;
  registerToken: (token: string) => Promise<void>;
}): Promise<void> {
  await App.addListener("appUrlOpen", (event: URLOpenListenerEvent) => {
    const target = atlasDeepLink(event.url);
    if (target) options.navigate(target);
  });
  await PushNotifications.addListener("registration", (token: Token) => void options.registerToken(token.value));
  await PushNotifications.addListener("pushNotificationActionPerformed", (event: ActionPerformed) => {
    const target = atlasDeepLink(String(event.notification.data?.url ?? ""));
    if (target) options.navigate(target);
  });
}

/** Registration must be initiated from an explicit user gesture in the UI. */
export async function requestPushRegistration(): Promise<"granted" | "denied"> {
  const permission = await PushNotifications.requestPermissions();
  if (permission.receive !== "granted") return "denied";
  await PushNotifications.register();
  return "granted";
}
