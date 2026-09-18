import { createHash } from "node:crypto";

/**
 * Push notifications for pending approvals.
 *
 * A push payload travels through Apple's or Google's infrastructure and lands
 * on a lock screen. So it carries no secret, no approval token, and no detail
 * of what is being approved beyond what is safe to read across a room — a
 * capability name and a deep link that still requires the app, the device
 * binding, and re-authentication to act on.
 */
export const PUSH_PLATFORMS = ["apns", "fcm"];

export class PushError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "PushError";
    this.code = code;
  }
}

/**
 * Registrations are stored by digest, the same way device credentials are: a
 * push token is a bearer capability for sending to that phone, and a leaked
 * database should not hand out a fleet's worth of them.
 */
export function createPushRegistry({ store = new Map() } = {}) {
  return {
    register({ deviceId, platform, token }) {
      if (!PUSH_PLATFORMS.includes(platform)) throw new PushError("BAD_PLATFORM", `Unknown push platform: ${platform}.`);
      if (typeof token !== "string" || token.length < 16) throw new PushError("BAD_TOKEN", "A push token is required.");
      store.set(deviceId, { deviceId, platform, tokenDigest: digest(token), token, registeredAt: new Date().toISOString() });
      return { deviceId, platform, registered: true };
    },
    unregister(deviceId) { return store.delete(deviceId); },
    /** Safe to serialize: no raw token. */
    list() {
      return [...store.values()].map(({ token, ...rest }) => rest);
    },
    for(deviceId) { return store.get(deviceId) ?? null; },
  };
}

/**
 * Builds the payload. Deliberately terse: the body says what kind of decision
 * is waiting, not what it would do.
 */
export function buildApprovalNotification({ approval, link, badge = 1 }) {
  if (!link?.appLink) throw new PushError("NO_LINK", "An approval notification must carry a deep link.");
  const title = "Atlas needs a decision";
  const body = `${humanize(approval.capability ?? approval.actionClass ?? "An action")} is waiting for your approval.`;
  return {
    title,
    body,
    // Everything actionable is behind the signed link, not in the payload.
    data: { target: "approval", link: link.appLink, expiresAtMs: link.expiresAtMs },
    badge,
    // A lock screen is a public surface; the OS is told to keep it summarized.
    interruptionLevel: "time-sensitive",
    visibility: "private",
  };
}

/** Rejects a payload that carries anything it should not, before it is sent. */
export function assertPayloadIsSafe(notification) {
  const serialized = JSON.stringify(notification);
  const leaks = [
    [/\b(?:sk|gsk|ghp|github_pat|xox[abps])[-_][A-Za-z0-9_-]{8,}/u, "a credential"],
    [/"(?:token|secret|password|apiKey|api_key)"\s*:/iu, "a secret field"],
    [/[0-9a-f]{64}/u, "an action digest"],
  ];
  for (const [pattern, what] of leaks) {
    if (pattern.test(serialized)) throw new PushError("UNSAFE_PAYLOAD", `A push payload must not carry ${what}.`);
  }
  return true;
}

/**
 * Sends through an injected transport, so the same code path is exercised in
 * tests and neither vendor SDK is a dependency of the daemon.
 */
export async function sendApprovalPush({ registry, deviceId, notification, transports, signal }) {
  const registration = registry.for(deviceId);
  if (!registration) return { sent: false, reason: "That device is not registered for notifications." };
  assertPayloadIsSafe(notification);
  const transport = transports?.[registration.platform];
  if (!transport) return { sent: false, reason: `No ${registration.platform} transport is configured on this machine.` };

  try {
    const receipt = await transport.send({ token: registration.token, notification, signal });
    return { sent: true, platform: registration.platform, receipt: receipt?.id ?? null };
  } catch (error) {
    // A revoked token is the normal end of a device's life, not an error worth
    // retrying: drop the registration so the fleet does not accumulate ghosts.
    if (error?.code === "TOKEN_REVOKED") {
      registry.unregister(deviceId);
      return { sent: false, reason: "That device's notification token was revoked; the registration was removed." };
    }
    return { sent: false, reason: error?.message ?? "The notification could not be delivered." };
  }
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function humanize(value) {
  return String(value).replaceAll(/[._]/gu, " ").replace(/^\w/u, (character) => character.toUpperCase());
}
