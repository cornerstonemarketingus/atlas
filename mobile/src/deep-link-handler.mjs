/**
 * Turns an incoming universal link or app-scheme URL into a screen.
 *
 * Every link is verified against the daemon's signer before anything is
 * navigated to, and a link never carries authority on its own: opening an
 * approval shows it, and the decision still goes through the daemon after
 * biometric re-authentication where the action calls for it.
 */
export function createDeepLinkHandler({ signer, deviceId, navigate, spentNonces = new Set(), onRejected = () => {} }) {
  return {
    async handle(url, { now = Date.now() } = {}) {
      const verified = signer.verify(url, { deviceId, now, spentNonces });
      if (!verified.valid) {
        // Refusals are shown, not swallowed: a link that does not open is a
        // thing the operator needs explained.
        onRejected({ url, reason: verified.reason });
        return { opened: false, reason: verified.reason };
      }

      // The nonce is spent on open, so a forwarded notification is already
      // dead by the time anyone else taps it.
      if (verified.target === "approval") spentNonces.add(verified.nonce);

      await navigate({ screen: verified.target, id: verified.id });
      return { opened: true, screen: verified.target, id: verified.id };
    },
  };
}
