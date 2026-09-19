/**
 * When the phone must ask for a face or a fingerprint before an approval.
 *
 * The threat is a specific one: an unlocked phone left on a desk. Session
 * authentication proves the device was enrolled; it does not prove the person
 * holding it now is the operator. So high-risk approvals re-authenticate at
 * the moment of the decision, and the freshness window is short enough that a
 * single check cannot cover an afternoon.
 */
export const BIOMETRIC_REQUIRED_CLASSES = new Set(["sensitive_input", "submit", "transfer", "destructive"]);
export const BIOMETRIC_REQUIRED_CAPABILITIES = new Set([
  "communications.send",
  "infrastructure.write",
  "browser.submit",
  "browser.upload",
  "computer.high_risk",
  "repository.execute",
]);

/** A re-authentication counts as fresh for this long, and no longer. */
export const FRESHNESS_MS = 120_000;

export function biometricDecision({ approval, lastVerifiedAtMs = null, now = Date.now(), biometricsAvailable = true }) {
  const required = BIOMETRIC_REQUIRED_CAPABILITIES.has(approval?.capability)
    || BIOMETRIC_REQUIRED_CLASSES.has(approval?.actionClass)
    || approval?.risk === "critical";

  if (!required) return { required: false, satisfied: true, reason: "This approval does not need re-authentication." };

  if (!biometricsAvailable) {
    // Not silently downgraded to "tap to confirm": the operator is told the
    // protection is missing and asked to decide on a device that has it.
    return {
      required: true,
      satisfied: false,
      fallback: "device-passcode",
      reason: "This action needs re-authentication, and biometrics are unavailable on this device. Use the device passcode, or approve from a device with biometrics.",
    };
  }

  const fresh = lastVerifiedAtMs !== null && now - lastVerifiedAtMs < FRESHNESS_MS;
  return fresh
    ? { required: true, satisfied: true, reason: `Re-authenticated ${Math.round((now - lastVerifiedAtMs) / 1000)}s ago.` }
    : { required: true, satisfied: false, reason: "Confirm it is you before approving this." };
}
