/**
 * The desktop subsystem shares one error class with the companion's desktop
 * runtime (apps/windows-companion/src/desktop), so a refusal raised by the
 * companion's rules and one raised by the safety layer here are the same
 * shape: `{ code, message, blocked?, unblock? }`.
 */
import { DesktopError } from "../../../../windows-companion/src/desktop/actions.mjs";

export { DesktopError };

/**
 * Codes after which the control loop must stop rather than try to recover:
 * a person (or the absence of one) decided, and retrying would be working
 * around that decision.
 */
export const TERMINAL_CODES = Object.freeze(new Set([
  "EMERGENCY_STOPPED",
  "SESSION_EXPIRED",
  "SESSION_ENDED",
  "SESSION_PAUSED",
  "SESSION_REVOKED",
  "NO_SESSION",
  "DEVICE_REVOKED",
  "DEVICE_NOT_ENROLLED",
  "POLICY_DENIED",
  "APPROVAL_REQUIRED",
  "SCOPE_DENIED",
  "APP_NOT_ALLOWLISTED",
  "PATH_NOT_PERMITTED",
  "UNSUPPORTED",
  "ABORTED",
  // raised by the companion's DesktopSession rules
  "ACTION_DENIED",
  "STEP_LIMIT",
  "INVALID_ACTION",
]));

/** Codes that mean "the thing you pointed at moved or vanished": re-locate and retry once. */
export const RECOVERABLE_CODES = Object.freeze(new Set(["STALE_ELEMENT", "ELEMENT_NOT_FOUND", "NO_TARGET"]));

/** Codes that mean the action was refused (not attempted), for the audit trail. */
export const REFUSAL_CODES = Object.freeze(new Set([...TERMINAL_CODES].filter((code) => code !== "ABORTED")));

export function desktopError(code, message) {
  return new DesktopError(code, message);
}
