import {
  SECRET_REDACTION_SCHEMA_VERSION,
  SecretRedactionError,
  type SecretCategory,
  type SecretRedactionFinding,
  type SecretRedactionResult,
  type SecretRedactor,
} from "../domain/secret-redaction.js";

const DEFAULT_MAX_INPUT_CHARACTERS = 1024 * 1024;
const DEFAULT_FINGERPRINT_LENGTH = 8;
const MAX_FINGERPRINT_LENGTH = 32;

/**
 * Domain separation prefix. Without it the fingerprint would be a plain
 * SHA-256 prefix of the secret, which a rainbow table of leaked credentials
 * could confirm; with it the placeholder only ever proves "same value here as
 * there", which is the only property the model actually needs.
 */
const FINGERPRINT_DOMAIN = "atlas.secret-redaction.v1:";

/**
 * `\b` is useless for credential shapes because `-` and `_` are word
 * boundaries, so `sk-ant-…` would match inside `xsk-ant-…`. These assert a real
 * token edge instead.
 */
const LEFT_EDGE = String.raw`(?<![A-Za-z0-9_\-])`;
const RIGHT_EDGE = String.raw`(?![A-Za-z0-9_\-])`;

/** Digest injected for testability; defaults to Web Crypto SHA-256. */
export type SecretDigestFunction = (data: Uint8Array<ArrayBuffer>) => Promise<ArrayBuffer>;

export interface PatternSecretRedactorOptions {
  readonly maxInputCharacters?: number;
  readonly fingerprintLength?: number;
  readonly digest?: SecretDigestFunction;
}

interface SecretRule {
  readonly category: SecretCategory;
  /** Capture group 1 is the secret itself; everything else is context kept in the output. */
  readonly pattern: RegExp;
}

interface SecretHit {
  readonly start: number;
  readonly end: number;
  readonly category: SecretCategory;
  readonly value: string;
  readonly ruleIndex: number;
}

/**
 * Rule order encodes precedence for identical spans: the first rule that can
 * claim a span wins, so `sk-ant-…` is reported as an Anthropic key rather than
 * an OpenAI one, and `GITHUB_TOKEN=ghp_…` as a GitHub token rather than a
 * generic assignment. Every pattern is deliberately anchored on a vendor prefix
 * or an assignment keyword — matching "looks random enough" alone would redact
 * git SHAs, UUIDs, and lockfile integrity hashes, which destroys the model's
 * ability to reason about the repository for no security gain.
 */
const RULES: readonly SecretRule[] = [
  {
    // The armour markers are kept so a reader still sees that a key lived here.
    category: "private-key",
    pattern: /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----([\s\S]*?)-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/g,
  },
  {
    // Requiring the `eyJ` header (base64url of `{"`) keeps ordinary dotted
    // identifiers out; a bare "three base64url segments" rule matches far too much.
    category: "jwt",
    pattern: new RegExp(
      `${LEFT_EDGE}(eyJ[A-Za-z0-9_-]{4,}\\.[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,})${RIGHT_EDGE}`,
      "g",
    ),
  },
  {
    category: "aws-access-key-id",
    pattern: new RegExp(`${LEFT_EDGE}((?:AKIA|ASIA|ABIA|ACCA|AGPA|AIDA|AIPA|ANPA|ANVA|AROA)[0-9A-Z]{16})${RIGHT_EDGE}`, "g"),
  },
  {
    // A 40-character base64 blob is not distinctive on its own, so this one is
    // only trusted next to an AWS secret-key label.
    category: "aws-secret-access-key",
    pattern: /aws[_-]?secret[_-]?access[_-]?key["']?\s*[:=]\s*["']?([A-Za-z0-9/+=]{40})/gi,
  },
  {
    category: "github-token",
    pattern: new RegExp(`${LEFT_EDGE}(gh[pousr]_[A-Za-z0-9]{20,255})${RIGHT_EDGE}`, "g"),
  },
  {
    category: "github-token",
    pattern: new RegExp(`${LEFT_EDGE}(github_pat_[A-Za-z0-9_]{20,255})${RIGHT_EDGE}`, "g"),
  },
  {
    category: "groq-api-key",
    pattern: new RegExp(`${LEFT_EDGE}(gsk_[A-Za-z0-9]{20,})${RIGHT_EDGE}`, "g"),
  },
  {
    category: "anthropic-api-key",
    pattern: new RegExp(`${LEFT_EDGE}(sk-ant-[A-Za-z0-9_-]{16,})${RIGHT_EDGE}`, "g"),
  },
  {
    category: "openai-api-key",
    pattern: new RegExp(`${LEFT_EDGE}(sk-(?:proj-)?[A-Za-z0-9_-]{16,})${RIGHT_EDGE}`, "g"),
  },
  {
    // Publishable keys (`pk_live_`) are public by design and stay readable.
    category: "stripe-key",
    pattern: new RegExp(`${LEFT_EDGE}((?:sk|rk)_(?:live|test)_[A-Za-z0-9]{10,})${RIGHT_EDGE}`, "g"),
  },
  {
    category: "stripe-key",
    pattern: new RegExp(`${LEFT_EDGE}(whsec_[A-Za-z0-9]{16,})${RIGHT_EDGE}`, "g"),
  },
  {
    category: "slack-token",
    pattern: new RegExp(`${LEFT_EDGE}(xox[abprs]-[A-Za-z0-9-]{10,})${RIGHT_EDGE}`, "g"),
  },
  {
    // Length is open-ended: Google keys are 39 characters today, and a slightly
    // longer lookalike is far cheaper to over-redact than to miss.
    category: "google-api-key",
    pattern: new RegExp(`${LEFT_EDGE}(AIza[0-9A-Za-z_-]{35,})${RIGHT_EDGE}`, "g"),
  },
  {
    // Connection strings smuggle credentials past every prefix rule above:
    // only the password inside `scheme://user:password@host` is removed so the
    // host and user still read normally.
    category: "url-credentials",
    pattern: /[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:([^\s:/@]{3,})@/gi,
  },
  {
    /*
     * Env-style assignments only, and deliberately narrow on three axes,
     * because a loose version of this rule shreds ordinary source:
     *   - the line must start with the key, so prose ("the token: foo") and
     *     mid-expression code survive;
     *   - the key must *end* with a credential word, so `inputTokens:`,
     *     `max_new_tokens=` and `token_embedding_table =` are left alone;
     *   - the value charset excludes code punctuation and the trailing
     *     assertion rejects anything followed by `(`, so `token: string;` and
     *     `token = randomBytes(32)` are not mistaken for credentials.
     */
    category: "generic-secret",
    pattern:
      /^[ \t]*(?:-[ \t]+)?(?:export[ \t]+)?["']?[A-Za-z0-9_.-]*?(?:SECRET|PASSWORD|PASSWD|TOKEN|API[_-]?KEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY|CREDENTIALS?)["']?[ \t]*[:=][ \t]*["']?([A-Za-z0-9_\-./+=:~!@#$%^&*]{6,512})(?![A-Za-z0-9_\-./+=:~!@#$%^&*(])/gim,
  },
];

/**
 * Redacts credential-shaped strings and replaces each with a stable,
 * non-reversible placeholder such as `[redacted:github-token:a1b2c3d4]`.
 *
 * The bias is deliberate: a slightly over-eager redaction of a
 * credential-shaped assignment is cheap, while forwarding one real customer
 * key to a model provider is not recoverable.
 */
export class PatternSecretRedactor implements SecretRedactor {
  readonly #maxInputCharacters: number;
  readonly #fingerprintLength: number;
  readonly #digest: SecretDigestFunction;

  public constructor(options: PatternSecretRedactorOptions = {}) {
    this.#maxInputCharacters = options.maxInputCharacters ?? DEFAULT_MAX_INPUT_CHARACTERS;
    this.#fingerprintLength = options.fingerprintLength ?? DEFAULT_FINGERPRINT_LENGTH;
    this.#digest = options.digest ?? ((data) => crypto.subtle.digest("SHA-256", data));
    if (!Number.isSafeInteger(this.#maxInputCharacters) || this.#maxInputCharacters < 1) {
      throw new SecretRedactionError("INVALID_LIMIT", "maxInputCharacters must be a positive safe integer.");
    }
    if (
      !Number.isSafeInteger(this.#fingerprintLength) ||
      this.#fingerprintLength < 4 ||
      this.#fingerprintLength > MAX_FINGERPRINT_LENGTH
    ) {
      throw new SecretRedactionError(
        "INVALID_LIMIT",
        `fingerprintLength must be an integer between 4 and ${MAX_FINGERPRINT_LENGTH}.`,
      );
    }
  }

  public async redact(text: string): Promise<SecretRedactionResult> {
    if (typeof text !== "string") {
      throw new SecretRedactionError("INVALID_INPUT", "Secret redaction requires a string input.");
    }

    // Scanning is linear per rule, but an unbounded blob still means unbounded
    // work; the tail is dropped rather than passed through unscanned, because
    // passing it through is exactly the leak this class exists to prevent.
    const truncated = text.length > this.#maxInputCharacters;
    const scanned = truncated ? boundedPrefix(text, this.#maxInputCharacters) : text;

    const hits = selectNonOverlapping(collectHits(scanned));
    const fingerprints = await this.#fingerprintAll(hits);

    let rebuilt = "";
    let cursor = 0;
    let redactionCount = 0;
    const counts = new Map<SecretCategory, number>();
    for (const hit of hits) {
      // Every hit was fingerprinted above; skipping one would silently emit the
      // secret, so an absent fingerprint must fail rather than fall through.
      const fingerprint = fingerprints.get(hit.value);
      if (fingerprint === undefined) {
        throw new SecretRedactionError("DIGEST_FAILED", "A detected secret was left unfingerprinted.");
      }
      rebuilt += scanned.slice(cursor, hit.start);
      rebuilt += `[redacted:${hit.category}:${fingerprint}]`;
      cursor = hit.end;
      redactionCount += 1;
      counts.set(hit.category, (counts.get(hit.category) ?? 0) + 1);
    }
    rebuilt += scanned.slice(cursor);

    return {
      schemaVersion: SECRET_REDACTION_SCHEMA_VERSION,
      text: truncated ? withOverflowMarker(rebuilt, text.length - scanned.length) : rebuilt,
      redactionCount,
      findings: toFindings(counts),
      scannedCharacters: scanned.length,
      truncated,
    };
  }

  async #fingerprintAll(hits: readonly SecretHit[]): Promise<ReadonlyMap<string, string>> {
    const fingerprints = new Map<string, string>();
    for (const hit of hits) {
      if (fingerprints.has(hit.value)) continue;
      fingerprints.set(hit.value, await this.#fingerprint(hit.value));
    }
    return fingerprints;
  }

  async #fingerprint(value: string): Promise<string> {
    const encoded = new Uint8Array(new TextEncoder().encode(`${FINGERPRINT_DOMAIN}${value}`));
    let digest: ArrayBuffer;
    try {
      digest = await this.#digest(encoded);
    } catch (cause) {
      // Failing closed: without a fingerprint we cannot emit a placeholder, and
      // emitting the original text instead would leak the secret.
      throw new SecretRedactionError(
        "DIGEST_FAILED",
        "Unable to fingerprint a detected secret; refusing to emit unredacted text.",
        { cause },
      );
    }
    const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    if (hex.length < this.#fingerprintLength) {
      throw new SecretRedactionError(
        "DIGEST_FAILED",
        "Digest implementation returned too few bytes to fingerprint a secret.",
      );
    }
    return hex.slice(0, this.#fingerprintLength);
  }
}

function collectHits(text: string): SecretHit[] {
  const hits: SecretHit[] = [];
  for (const [ruleIndex, rule] of RULES.entries()) {
    // `d` yields per-group offsets so only the secret is replaced and the
    // surrounding key or PEM armour survives for the reader.
    const pattern = new RegExp(rule.pattern.source, `${rule.pattern.flags}d`);
    for (const match of text.matchAll(pattern)) {
      const span = match.indices?.[1];
      const value = match[1];
      if (span === undefined || value === undefined || value.length === 0) continue;
      if (isNonSecretValue(value)) continue;
      hits.push({ start: span[0], end: span[1], category: rule.category, value, ruleIndex });
    }
  }
  return hits;
}

/**
 * Earliest span wins, then the longest span, then rule precedence. Without a
 * total order the same input could redact differently between runs, and a
 * placeholder that moves is worse than no placeholder for review and diffing.
 */
function selectNonOverlapping(hits: readonly SecretHit[]): readonly SecretHit[] {
  const ordered = [...hits].sort((left, right) =>
    left.start - right.start ||
    (right.end - right.start) - (left.end - left.start) ||
    left.ruleIndex - right.ruleIndex);
  const selected: SecretHit[] = [];
  let boundary = -1;
  for (const hit of ordered) {
    if (hit.start < boundary) continue;
    selected.push(hit);
    boundary = hit.end;
  }
  return selected;
}

/** A type annotation is an assignment shape, not a credential: `token: string;`. */
const TYPE_ANNOTATION_VALUES: ReadonlySet<string> = new Set([
  "bigint", "boolean", "double", "false", "float", "integer", "never", "null",
  "nullable", "number", "object", "string", "symbol", "true", "undefined", "unknown", "void",
]);

/**
 * Values that only reference or illustrate a secret. Redacting `${GITHUB_TOKEN}`
 * or `<your-api-key>` costs the reader real meaning and protects nothing, and no
 * vendor credential contains template punctuation, so this applies to every
 * rule; a PEM header is left to the private-key rule, which redacts the body.
 */
function isNonSecretValue(value: string): boolean {
  return value.startsWith("<") ||
    value.startsWith("-----") ||
    value.includes("${") ||
    value.includes("{{") ||
    TYPE_ANNOTATION_VALUES.has(value.toLowerCase()) ||
    /^[*x•]+$/i.test(value);
}

/**
 * Cuts back to the last whitespace so the scan never ends mid-token: half of a
 * credential is still a leak, and a partial token would also escape every rule.
 */
function boundedPrefix(text: string, maxCharacters: number): string {
  const prefix = text.slice(0, maxCharacters);
  for (let index = prefix.length - 1; index >= 0; index -= 1) {
    if (/\s/u.test(prefix.charAt(index))) return prefix.slice(0, index + 1);
  }
  return "";
}

function withOverflowMarker(text: string, droppedCharacters: number): string {
  const marker = `[redacted:unscanned:${droppedCharacters}-characters]`;
  return text.length === 0 ? marker : `${text}\n${marker}`;
}

function toFindings(counts: ReadonlyMap<SecretCategory, number>): readonly SecretRedactionFinding[] {
  return [...counts.entries()]
    .map(([category, count]) => ({ category, count }))
    .sort((left, right) => left.category.localeCompare(right.category));
}
