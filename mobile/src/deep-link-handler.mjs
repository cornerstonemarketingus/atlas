/**
 * Turns an incoming universal link or app-scheme URL into a screen.
 *
 * Every link is verified against the daemon's signer before anything is
 * navigated to, and a link never carries authority on its own: opening an
 * approval shows it, and the decision still goes through the daemon after
 * biometric re-authentication where the action calls for it.
 */
export function createDeepLinkHandler({ signer, deviceId, navigate, spentNonces, onRejected = () => {} }) {
  // A ledger that only lives as long as the process makes "single use" mean
  // "single use until the app is restarted", which for a forwarded approval
  // notification is not a restriction at all. It must be supplied, and it
  // must have been loaded, rather than defaulting to an empty Set.
  if (!spentNonces) throw new Error("A deep link handler needs a spent-nonce ledger that survives a restart.");

  return {
    async handle(url, { now = Date.now() } = {}) {
      if (spentNonces.loaded === false) {
        // Before the ledger is read back, every nonce looks unused. Opening
        // a link in that window is exactly the replay this guards against.
        const reason = "Atlas is still starting up. Open the link again in a moment.";
        onRejected({ url, reason });
        return { opened: false, reason };
      }

      const verified = signer.verify(url, { deviceId, now, spentNonces });
      if (!verified.valid) {
        // Refusals are shown, not swallowed: a link that does not open is a
        // thing the operator needs explained.
        onRejected({ url, reason: verified.reason });
        return { opened: false, reason: verified.reason };
      }

      // The nonce is spent on open, so a forwarded notification is already
      // dead by the time anyone else taps it -- and stays dead across a
      // restart, because the ledger is written before the screen opens.
      if (verified.target === "approval") await spentNonces.add(verified.nonce, verified.expiresAtMs);

      await navigate({ screen: verified.target, id: verified.id });
      return { opened: true, screen: verified.target, id: verified.id };
    },
  };
}
