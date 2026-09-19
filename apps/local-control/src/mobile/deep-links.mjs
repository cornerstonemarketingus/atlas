import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Deep links that open the exact task or approval, and nothing else.
 *
 * A link that arrives by push notification is attacker-reachable: anyone who
 * can get a URL in front of the operator can try one. So a link is a signed
 * capability rather than an identifier - it names one resource, expires, and
 * is bound to the device that will open it. Tampering with any part of it
 * invalidates the signature, and an approval link is one-time.
 *
 * Crucially, the link authorizes *opening* the approval, never granting it.
 * The decision still happens in the app, against the daemon, after biometric
 * re-authentication where the action calls for it.
 */
export const LINK_VERSION = 1;
export const LINK_TARGETS = ["task", "approval", "session"];

const DEFAULT_LIFETIME_MS = 15 * 60_000;
/** Unit separator: cannot appear in any signed field, so fields cannot be confused. */
const FIELD_SEPARATOR = String.fromCharCode(31);

export class DeepLinkError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "DeepLinkError";
    this.code = code;
  }
}

export function createDeepLinkSigner({ secret, scheme = "atlas", universalHost = null }) {
  if (typeof secret !== "string" || secret.length < 32) {
    throw new DeepLinkError("WEAK_SECRET", "A deep-link signing secret must contain at least 32 characters.");
  }

  function payloadOf({ target, id, deviceId, expiresAtMs, nonce }) {
    // The device is part of the signed payload, so a link captured from one
    // phone's notification cannot be replayed on another.
    return [LINK_VERSION, target, id, deviceId, expiresAtMs, nonce].join(FIELD_SEPARATOR);
  }

  function signPayload(payload) {
    return createHmac("sha256", secret).update(payload).digest("base64url");
  }

  return {
    /** Returns both the app-scheme and the universal-link form of one link. */
    create({ target, id, deviceId, lifetimeMs = DEFAULT_LIFETIME_MS, now = Date.now() }) {
      if (!LINK_TARGETS.includes(target)) throw new DeepLinkError("BAD_TARGET", `Unknown deep-link target: ${target}.`);
      if (!/^[0-9a-f-]{36}$/u.test(id ?? "")) throw new DeepLinkError("BAD_ID", "A deep link must name a specific resource.");
      if (!deviceId) throw new DeepLinkError("NO_DEVICE", "A deep link must be bound to a paired device.");

      const expiresAtMs = now + lifetimeMs;
      const nonce = randomBytes(12).toString("base64url");
      const signature = signPayload(payloadOf({ target, id, deviceId, expiresAtMs, nonce }));
      const query = new URLSearchParams({ v: String(LINK_VERSION), id, d: deviceId, e: String(expiresAtMs), n: nonce, s: signature });
      return {
        nonce,
        expiresAtMs,
        appLink: `${scheme}://${target}?${query}`,
        universalLink: universalHost ? `https://${universalHost}/open/${target}?${query}` : null,
      };
    },

    /**
     * @param spentNonces a Set of nonces already used; approval links are
     *   one-time, so a link forwarded to someone else is already dead.
     */
    verify(link, { deviceId, now = Date.now(), spentNonces = null } = {}) {
      let url;
      try {
        url = new URL(link);
      } catch {
        return { valid: false, reason: "That is not a usable link." };
      }

      const target = url.protocol.startsWith("http")
        ? url.pathname.replace(/^\/open\//u, "").replace(/\/$/u, "")
        : url.hostname || url.pathname.replace(/^\/+/u, "");
      if (!LINK_TARGETS.includes(target)) return { valid: false, reason: "That link does not point at a task or an approval." };

      const parameters = url.searchParams;
      if (parameters.get("v") !== String(LINK_VERSION)) return { valid: false, reason: "That link was made by a different version of Atlas." };

      const id = parameters.get("id") ?? "";
      const linkDevice = parameters.get("d") ?? "";
      const expiresAtMs = Number(parameters.get("e") ?? 0);
      const nonce = parameters.get("n") ?? "";
      const signature = parameters.get("s") ?? "";

      const expected = signPayload(payloadOf({ target, id, deviceId: linkDevice, expiresAtMs, nonce }));
      // Constant-time, so a forger learns nothing from how long a rejection takes.
      const a = Buffer.from(expected);
      const b = Buffer.from(signature);
      if (a.length !== b.length || !timingSafeEqual(a, b)) return { valid: false, reason: "That link has been altered or was not issued by this Atlas." };

      if (!Number.isFinite(expiresAtMs) || expiresAtMs <= now) return { valid: false, reason: "That link has expired. Open Atlas and find the item there." };
      if (deviceId && linkDevice !== deviceId) return { valid: false, reason: "That link was issued for a different device." };
      if (spentNonces?.has(nonce)) return { valid: false, reason: "That link has already been used." };

      return { valid: true, reason: null, target, id, deviceId: linkDevice, nonce, expiresAtMs };
    },
  };
}

/**
 * The association files iOS and Android fetch to trust a universal link.
 * Generated rather than hand-written, because a typo in either silently
 * downgrades every link to opening a web page instead of the app.
 */
export function appleAppSiteAssociation({ teamId, bundleId }) {
  return {
    applinks: {
      details: [{ appID: `${teamId}.${bundleId}`, paths: ["/open/*"] }],
    },
    webcredentials: { apps: [`${teamId}.${bundleId}`] },
  };
}

export function androidAssetLinks({ packageName, sha256CertificateFingerprints }) {
  return [{
    relation: ["delegate_permission/common.handle_all_urls"],
    target: {
      namespace: "android_app",
      package_name: packageName,
      sha256_cert_fingerprints: sha256CertificateFingerprints,
    },
  }];
}
