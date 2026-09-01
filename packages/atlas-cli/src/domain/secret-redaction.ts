/**
 * Contract for removing credentials from repository content before it leaves
 * this process — into a model request, an audit log, or a rendered diff.
 *
 * Atlas reads other people's repositories. A stray `.env`, a hardcoded token in
 * a test fixture, or a committed private key must never be forwarded verbatim
 * to a third-party model provider, so redaction is modelled as an explicit
 * boundary contract rather than an incidental string cleanup.
 *
 * Redaction is asynchronous because a stable placeholder requires a digest and
 * Web Crypto only exposes one asynchronously.
 */

export const SECRET_REDACTION_SCHEMA_VERSION = 1 as const;

export type SecretCategory =
  | "anthropic-api-key"
  | "aws-access-key-id"
  | "aws-secret-access-key"
  | "generic-secret"
  | "github-token"
  | "google-api-key"
  | "groq-api-key"
  | "jwt"
  | "openai-api-key"
  | "private-key"
  | "slack-token"
  | "stripe-key"
  | "url-credentials";

/**
 * How many secrets of one shape were removed. Deliberately carries no sample,
 * offset, or length of the secret: an audit record that quotes the credential
 * re-creates the leak it is supposed to prove was closed.
 */
export interface SecretRedactionFinding {
  readonly category: SecretCategory;
  readonly count: number;
}

export interface SecretRedactionSummary {
  readonly schemaVersion: typeof SECRET_REDACTION_SCHEMA_VERSION;
  readonly redactionCount: number;
  /** Sorted by category so audit records of the same input compare equal. */
  readonly findings: readonly SecretRedactionFinding[];
  readonly scannedCharacters: number;
  /** True when the input exceeded the scan bound and the unscanned tail was dropped. */
  readonly truncated: boolean;
}

export interface SecretRedactionResult extends SecretRedactionSummary {
  readonly text: string;
}

export type SecretRedactionErrorCode = "DIGEST_FAILED" | "INVALID_INPUT" | "INVALID_LIMIT";

export class SecretRedactionError extends Error {
  public constructor(
    public readonly code: SecretRedactionErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "SecretRedactionError";
  }
}

export interface SecretRedactor {
  redact(text: string): Promise<SecretRedactionResult>;
}

/** Drops the redacted text so a summary can be logged without carrying content. */
export function summarizeRedaction(result: SecretRedactionResult): SecretRedactionSummary {
  return {
    schemaVersion: result.schemaVersion,
    redactionCount: result.redactionCount,
    findings: result.findings,
    scannedCharacters: result.scannedCharacters,
    truncated: result.truncated,
  };
}
