/**
 * Redaction for anything that becomes model context, a receipt, or a log line.
 *
 * Pattern-based on purpose. Entropy scanning looks attractive and is a trap
 * here: it redacts git SHAs, lockfile hashes and base64 content, which wrecks
 * the model's ability to reason about a repository. So this matches shapes
 * that are credentials and very little else — a vendor prefix, a PEM block, an
 * Authorization header, an assignment to a key-ish name.
 *
 * It is not complete, and cannot be: a credential in an unrecognized format
 * passes through. It is the last boundary before repository content becomes
 * model context, which is why it must never be the *only* control.
 */
/**
 * Order matters: the broad "a name that says secret, then a value" patterns
 * run first and consume the whole assignment. Running them after the
 * vendor-prefix patterns left the tail of an already-redacted value behind.
 */
const PATTERNS = [
  // An assignment to a secret-ish name, which is what a .env file is.
  [/\b([A-Za-z_][A-Za-z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|APIKEY|PRIVATE_KEY|ACCESS_KEY|CLIENT_SECRET|CREDENTIAL)[A-Za-z0-9_]*)\s*[:=]\s*["']?[^\s"',;]{6,}["']?/giu, "$1=[redacted]"],
  // JSON fields whose name says what they hold.
  [/"(secret|token|password|api_?key|private_?key|access_?key|client_?secret|credential)"\s*:\s*"[^"]{4,}"/giu, '"$1":"[redacted]"'],
  // Authorization headers, including the scheme and everything after it.
  [/\b([Aa]uthorization)\s*[:=]\s*(?:Bearer|Basic|Token|Digest)?\s*\S+/gu, "$1: [redacted]"],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gu, "Bearer [redacted]"],
  // Vendor-prefixed tokens.
  [/\b(?:sk|pk|rk|gsk|ghp|gho|ghu|ghs|ghr|github_pat|glpat|xox[abprs]|shpat|sq0atp|AIza|SG\.)[-_][A-Za-z0-9_-]{10,}/gu, "[redacted credential]"],
  [/\bsk-(?:proj-|live-|test-)?[A-Za-z0-9_-]{16,}/gu, "[redacted credential]"],
  [/\bAKIA[0-9A-Z]{16}\b/gu, "[redacted key id]"],
  // Private keys, in full.
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gu, "[redacted private key]"],
  // Credentials embedded in a URL.
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/giu, "$1[redacted]@"],
];

export function redactSecrets(text) {
  let out = String(text ?? "");
  for (const [pattern, replacement] of PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

/** True when redaction changed anything — useful for auditing that it fired. */
export function containsSecret(text) {
  return redactSecrets(text) !== String(text ?? "");
}
