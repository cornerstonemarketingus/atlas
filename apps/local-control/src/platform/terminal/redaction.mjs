/**
 * Output redaction for the terminal controller.
 *
 * A JavaScript re-implementation of the rule set in
 * packages/atlas-cli/src/infrastructure/pattern-secret-redactor.ts, kept
 * synchronous because it runs on every output chunk. Every pattern is anchored
 * on a vendor prefix or an assignment keyword: "looks random enough" alone
 * would redact git SHAs and lockfile hashes, which blinds the agent for no
 * security gain.
 *
 * Placeholders carry the category only (`[redacted:github-token]`), never a
 * digest of the value, so a transcript cannot be used to confirm a guess.
 */
const LEFT_EDGE = String.raw`(?<![A-Za-z0-9_\-])`;
const RIGHT_EDGE = String.raw`(?![A-Za-z0-9_\-])`;

/** Capture group 1 is the secret; everything else is context kept in the output. */
const RULES = [
  { category: "private-key", pattern: /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----([\s\S]*?)-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/g },
  { category: "jwt", pattern: new RegExp(`${LEFT_EDGE}(eyJ[A-Za-z0-9_-]{4,}\\.[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,})${RIGHT_EDGE}`, "g") },
  { category: "aws-access-key-id", pattern: new RegExp(`${LEFT_EDGE}((?:AKIA|ASIA|ABIA|ACCA|AGPA|AIDA|AIPA|ANPA|ANVA|AROA)[0-9A-Z]{16})${RIGHT_EDGE}`, "g") },
  { category: "aws-secret-access-key", pattern: /aws[_-]?secret[_-]?access[_-]?key["']?\s*[:=]\s*["']?([A-Za-z0-9/+=]{40})/gi },
  { category: "github-token", pattern: new RegExp(`${LEFT_EDGE}(gh[pousr]_[A-Za-z0-9]{20,255})${RIGHT_EDGE}`, "g") },
  { category: "github-token", pattern: new RegExp(`${LEFT_EDGE}(github_pat_[A-Za-z0-9_]{20,255})${RIGHT_EDGE}`, "g") },
  { category: "groq-api-key", pattern: new RegExp(`${LEFT_EDGE}(gsk_[A-Za-z0-9]{20,})${RIGHT_EDGE}`, "g") },
  { category: "anthropic-api-key", pattern: new RegExp(`${LEFT_EDGE}(sk-ant-[A-Za-z0-9_-]{16,})${RIGHT_EDGE}`, "g") },
  { category: "openai-api-key", pattern: new RegExp(`${LEFT_EDGE}(sk-(?:proj-)?[A-Za-z0-9_-]{16,})${RIGHT_EDGE}`, "g") },
  { category: "stripe-key", pattern: new RegExp(`${LEFT_EDGE}((?:sk|rk)_(?:live|test)_[A-Za-z0-9]{10,})${RIGHT_EDGE}`, "g") },
  { category: "stripe-key", pattern: new RegExp(`${LEFT_EDGE}(whsec_[A-Za-z0-9]{16,})${RIGHT_EDGE}`, "g") },
  { category: "slack-token", pattern: new RegExp(`${LEFT_EDGE}(xox[abprs]-[A-Za-z0-9-]{10,})${RIGHT_EDGE}`, "g") },
  { category: "google-api-key", pattern: new RegExp(`${LEFT_EDGE}(AIza[0-9A-Za-z_-]{35,})${RIGHT_EDGE}`, "g") },
  // Only the password inside `scheme://user:password@host` is removed.
  { category: "url-credentials", pattern: /[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:([^\s:/@]{3,})@/gi },
  {
    // Env-style assignments only: the key must start the line and *end* with a
    // credential word, so `max_new_tokens=` and `token: string;` survive.
    category: "generic-secret",
    pattern: /^[ \t]*(?:-[ \t]+)?(?:export[ \t]+)?["']?[A-Za-z0-9_.-]*?(?:SECRET|PASSWORD|PASSWD|TOKEN|API[_-]?KEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY|CREDENTIALS?)["']?[ \t]*[:=][ \t]*["']?([A-Za-z0-9_\-./+=:~!@#$%^&*]{6,512})(?![A-Za-z0-9_\-./+=:~!@#$%^&*(])/gim,
  },
];

/** Host environment keys whose values are treated as known secrets. */
const SECRET_KEY_PATTERN = /(SECRET|PASSWORD|PASSWD|TOKEN|API[_-]?KEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY|CREDENTIAL|AUTH)/i;
const MIN_KNOWN_SECRET_LENGTH = 8;

/** Structured credential payloads are removed even when their values have no
 * recognizable vendor prefix. References and capability metadata survive.
 */
const CREDENTIAL_FIELD = /^(?:password|passwd|secret|token|api[_-]?key|(?:access|refresh|session)[_-]?token|private[_-]?key|session[_-]?cookie|cookies?|set[_-]?cookie|authorization)$/iu;
export function redactStructured(value, redactText = createRedactor()) {
  const text = (input) => {
    const result = redactText(input);
    return typeof result === "string" ? result : result.text;
  };
  if (typeof value === "string") return text(value);
  if (Array.isArray(value)) return value.map((entry) => redactStructured(entry, redactText));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, entry]) => [text(key),
    CREDENTIAL_FIELD.test(key) && ((typeof entry === "string" && entry.length > 0) || (entry !== null && typeof entry === "object"))
      ? "[redacted:credential-field]" : redactStructured(entry, redactText)]));
  return value;
}

/**
 * Values of secret-named variables in the daemon's own environment. The child
 * never receives them (the environment is rebuilt from nothing), but a command
 * could still read one from a file it was allowed to see, so exact matches are
 * scrubbed from output as a second line of defence.
 */
export function hostSecretValues(environment = process.env) {
  const values = [];
  for (const [key, value] of Object.entries(environment)) {
    if (typeof value === "string" && value.length >= MIN_KNOWN_SECRET_LENGTH && SECRET_KEY_PATTERN.test(key)) values.push(value);
  }
  return values;
}

export function createRedactor({ knownSecrets = [] } = {}) {
  // Longest first, so a secret that contains another is replaced whole.
  const exact = [...new Set(knownSecrets.filter((value) => typeof value === "string" && value.length >= MIN_KNOWN_SECRET_LENGTH))]
    .sort((a, b) => b.length - a.length);

  return function redact(text) {
    if (typeof text !== "string" || text.length === 0) return { text: text ?? "", count: 0 };
    let count = 0;
    let output = text;
    for (const value of exact) {
      if (output.includes(value)) {
        const parts = output.split(value);
        count += parts.length - 1;
        output = parts.join("[redacted:known-secret]");
      }
    }
    for (const { category, pattern } of RULES) {
      pattern.lastIndex = 0;
      output = output.replace(pattern, (match, secret) => {
        if (!secret) return match;
        count += 1;
        const at = match.lastIndexOf(secret);
        return `${match.slice(0, at)}[redacted:${category}]${match.slice(at + secret.length)}`;
      });
    }
    return { text: output, count };
  };
}
