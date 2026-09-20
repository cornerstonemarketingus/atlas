/**
 * Crash reporting the operator opted into.
 *
 * Two rules. Nothing is sent without consent, and consent is off until it is
 * given rather than on until it is withdrawn. And whatever is sent is
 * redacted first, because a stack trace from an operator tool contains file
 * paths, repository names, and sometimes the argument that caused the crash.
 */
export const CONSENT_STATES = ["unasked", "granted", "denied"];

const REDACTIONS = [
  [/\b(?:sk|gsk|ghp|github_pat|xox[abps])[-_][A-Za-z0-9_-]{8,}/gu, "[credential]"],
  [/\bBearer\s+[A-Za-z0-9._-]+/giu, "Bearer [redacted]"],
  [/\b[\w.%+-]+@[\w.-]+\.[A-Za-z]{2,}\b/gu, "[email]"],
  // `\\\\` in a regex literal is two LITERAL backslashes, so this only ever
  // matched `C:\\Users\\` and every Windows crash report shipped the
  // operator's account name — under a consent dialog promising paths removed.
  [/(?:\/Users\/|\/home\/|[A-Za-z]:\\Users\\)[^\s/\\:"']+/gu, "[home]"],
  [/\b(?:\d[ -]?){13,19}\b/gu, "[card]"],
  [/\b(?:\d{1,3}\.){3}\d{1,3}\b/gu, "[ip]"],
];

export function redactDiagnostic(text) {
  let out = String(text ?? "");
  for (const [pattern, replacement] of REDACTIONS) out = out.replace(pattern, replacement);
  return out.slice(0, 8_000);
}

export function buildCrashReport({ consent, error, appVersion, platform, now = Date.now() }) {
  if (consent !== "granted") {
    return {
      send: false,
      reason: consent === "denied"
        ? "Diagnostics are turned off, so nothing was sent."
        : "Atlas has not asked about diagnostics yet, so nothing was sent.",
      // Kept locally either way, so the operator can read or share it themselves.
      local: { at: new Date(now).toISOString(), summary: redactDiagnostic(error?.message), stack: redactDiagnostic(error?.stack) },
    };
  }

  return {
    send: true,
    reason: null,
    report: {
      at: new Date(now).toISOString(),
      appVersion,
      platform,
      // No user identifier: a crash report does not need to know who it is.
      summary: redactDiagnostic(error?.message),
      stack: redactDiagnostic(error?.stack),
    },
  };
}

/** The consent prompt's own copy, so it says the same thing everywhere. */
export function consentCopy() {
  return {
    title: "Send diagnostics when Atlas crashes?",
    body: "Crash reports help fix problems. They include the error and where it happened, with credentials, email addresses, file paths and IP addresses removed. They never include your conversations, files, or approvals. You can change this at any time.",
    accept: "Send diagnostics",
    decline: "Do not send",
    defaultState: "unasked",
  };
}
