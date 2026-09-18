/**
 * What the phone shows when it cannot reach Atlas.
 *
 * An operator-approval app that renders a blank screen when the network drops
 * is worse than useless: the person cannot tell whether their approval went
 * through. Every state here names what is true and what the operator can do,
 * and an approval is never optimistically shown as granted.
 */
export const SESSION_STATES = ["ready", "connecting", "offline", "expired", "revoked", "unpaired"];

export function nextSessionState({ current = "connecting", event, now = Date.now(), expiresAtMs = null }) {
  switch (event?.type) {
    case "connected":
      return describe(expiresAtMs !== null && expiresAtMs <= now ? "expired" : "ready");
    case "network-lost":
      // Revoked and unpaired are facts about the account, not the network, so
      // losing connectivity must not overwrite them with a softer story.
      return describe(["revoked", "unpaired"].includes(current) ? current : "offline");
    case "unauthorized":
      return describe("expired");
    case "revoked":
      return describe("revoked");
    case "unpaired":
      return describe("unpaired");
    case "retry":
      return describe(["offline", "expired"].includes(current) ? "connecting" : current);
    default:
      return describe(current);
  }
}

function describe(state) {
  const copy = {
    ready: { title: "Connected", detail: "Atlas is reachable. Pending approvals are current.", canApprove: true, retryable: false },
    connecting: { title: "Connecting", detail: "Reaching your Atlas.", canApprove: false, retryable: false },
    offline: { title: "Offline", detail: "Your phone cannot reach Atlas right now. Anything shown below was last seen when you were connected, and may be out of date. You cannot approve while offline.", canApprove: false, retryable: true },
    expired: { title: "Session expired", detail: "Sign in again to see and answer approvals.", canApprove: false, retryable: true },
    revoked: { title: "Device revoked", detail: "This device was removed from your Atlas. Pair it again from the computer running Atlas.", canApprove: false, retryable: false },
    unpaired: { title: "Not paired", detail: "Pair this phone with the computer running Atlas to receive approvals.", canApprove: false, retryable: false },
  }[state];
  return { state, ...copy };
}

/**
 * Whether a cached approval may still be acted on.
 *
 * Never, while offline. A decision taken against a stale list can approve
 * something that was already withdrawn, and the operator would have no way to
 * know until afterwards.
 */
export function canActOnCachedApproval({ sessionState, cachedAtMs, now = Date.now(), maximumAgeMs = 60_000 }) {
  if (sessionState !== "ready") return { allowed: false, reason: "Atlas is not reachable, so this approval cannot be answered from here yet." };
  if (now - cachedAtMs > maximumAgeMs) return { allowed: false, reason: "This approval is older than the app can vouch for. Refresh before deciding." };
  return { allowed: true, reason: null };
}
