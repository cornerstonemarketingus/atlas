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
export function createPushRegistry({ store = new Map(), tokens = new Map() } = {}) {
  return {
    register({ deviceId, platform, token }) {
      if (!PUSH_PLATFORMS.includes(platform)) throw new PushError("BAD_PLATFORM", `Unknown push platform: ${platform}.`);
      if (typeof token !== "string" || token.length < 16) throw new PushError("BAD_TOKEN", "A push token is required.");
      // The docstring above promised registrations are stored by digest so a
      // leaked database cannot hand out a fleet's worth of push tokens — and
      // then kept the plaintext beside it. The raw token lives only in the
      // separate map the transport reads, which callers can back with a vault.
      store.set(deviceId, { deviceId, platform, tokenDigest: digest(token), registeredAt: new Date().toISOString() });
      tokens.set(deviceId, token);
      return { deviceId, platform, registered: true };
    },
    unregister(deviceId) { tokens.delete(deviceId); return store.delete(deviceId); },
    /** Safe to serialize: no raw token anywhere in the record. */
    list() {
      return [...store.values()];
    },
    for(deviceId) {
      const record = store.get(deviceId);
      return record ? { ...record, token: tokens.get(deviceId) ?? null } : null;
    },
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

/**
 * Rejects a payload that carries anything it should not, before it is sent.
 *
 * `data.link` is excluded from the scan on purpose: it is a signed,
 * device-bound, expiring capability that authorizes *opening* an approval and
 * nothing more, and it necessarily contains a long random-looking signature.
 * Everything else in the payload is checked.
 */
export function assertPayloadIsSafe(notification) {
  const { data = {}, ...rest } = notification ?? {};
  const { link, ...scannedData } = data;
  const serialized = JSON.stringify({ ...rest, data: scannedData });
  const leaks = [
    [/\b(?:sk|gsk|ghp|github_pat|xox[abps])[-_][A-Za-z0-9_-]{8,}/u, "a credential"],
    [/"(?:token|secret|password|apiKey|api_key)"\s*:/iu, "a secret field"],
    // Case-insensitive, and base64url too: anything that renders a digest
    // with toUpperCase() or as base64 walked straight past this onto a lock
    // screen — and the signer in deep-links.mjs emits base64url itself.
    [/[0-9a-fA-F]{64}/u, "an action digest"],
    // Long opaque strings anywhere other than the signed link.
    [/\b[A-Za-z0-9_-]{43,}\b/u, "something that looks like a token or digest"],
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
