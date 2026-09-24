/**
 * Secret-shaped string redaction for memory content.
 *
 * Memory outlives the task that produced it and is replayed into future model
 * contexts, so a credential that slips into an observation would be leaked
 * again and again. Redaction happens before storage: the raw value is never
 * written to disk, and the entry is flagged `redacted` so a reader knows the
 * text was altered.
 */
const SECRET_PATTERNS = [
  ["private_key", /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gu],
  ["anthropic_key", /\bsk-ant-[A-Za-z0-9_-]{16,}/gu],
  ["openai_key", /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/gu],
  ["aws_access_key", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/gu],
  ["github_token", /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/gu],
  ["slack_token", /\bxox[abprs]-[A-Za-z0-9-]{10,}/gu],
  ["groq_key", /\bgsk_[A-Za-z0-9]{20,}/gu],
  ["jwt", /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/gu],
  ["bearer_token", /\b(Bearer)\s+[A-Za-z0-9._~+/=-]{16,}/giu],
  ["url_credentials", /\b([a-z][a-z0-9+.-]*:\/\/)[^\s:/@]+:[^\s@/]+@/giu],
  ["assigned_secret", /\b((?:api[_-]?key|secret|password|passwd|token|access[_-]?key|client[_-]?secret)\s*[:=]\s*)(["']?)[^\s"',;]{6,}\2/giu],
];

/** Returns `{ text, redacted, kinds }`; `kinds` names what was found, never the value. */
export function redactSecrets(input) {
  let text = String(input ?? "");
  const kinds = [];
  for (const [kind, pattern] of SECRET_PATTERNS) {
    text = text.replace(pattern, (...match) => {
      kinds.push(kind);
      if (kind === "bearer_token") return `${match[1]} [REDACTED:${kind}]`;
      if (kind === "url_credentials") return `${match[1]}[REDACTED:${kind}]@`;
      if (kind === "assigned_secret") return `${match[1]}[REDACTED:${kind}]`;
      return `[REDACTED:${kind}]`;
    });
  }
  return { text, redacted: kinds.length > 0, kinds: [...new Set(kinds)] };
}
