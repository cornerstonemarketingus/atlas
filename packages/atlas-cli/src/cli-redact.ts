import { PatternSecretRedactor } from "./infrastructure/pattern-secret-redactor.js";
import { summarizeRedaction, type SecretRedactionSummary } from "./domain/secret-redaction.js";

const DEFAULT_MAX_CHARACTERS = 4 * 1024 * 1024;
const MAXIMUM_MAX_CHARACTERS = 64 * 1024 * 1024;

export interface RedactCommandDependencies {
  readonly readInput: () => Promise<string>;
  readonly write: (text: string) => void;
  readonly writeError: (text: string) => void;
}

/**
 * `atlas redact` — scrubs credentials from text on stdin and writes the result
 * to stdout.
 *
 * This exists so callers that are NOT this TypeScript package can use the one
 * redaction implementation. The GitHub Actions runner is plain JavaScript and
 * was writing raw build and test output into an uploaded artifact; the only
 * alternative to this subcommand was a second detector implementation in the
 * runner, which would have drifted from this one and produced two different
 * answers to "is this safe to publish".
 *
 * Text in, text out, because the caller owns the framing: a runner piping a
 * serialized JSON document through this gets valid JSON back, since
 * placeholders are plain text and contain no JSON metacharacters.
 */
export async function executeRedactCommand(
  args: readonly string[],
  dependencies: RedactCommandDependencies,
): Promise<number> {
  const maxCharacters = readMaxCharacters(args);
  if (maxCharacters === null) {
    dependencies.writeError(
      `--max-characters must be an integer between 1 and ${MAXIMUM_MAX_CHARACTERS}.\n`,
    );
    return 2;
  }
  const wantsSummary = args.includes("--summary");

  const input = await dependencies.readInput();
  const redactor = new PatternSecretRedactor({ maxInputCharacters: maxCharacters });

  let result;
  try {
    result = await redactor.redact(input);
  } catch (error: unknown) {
    // Fails closed, like every other redaction boundary here: nothing reaches
    // stdout, so a caller redirecting this into a file gets an empty file and a
    // non-zero exit rather than the unredacted original.
    dependencies.writeError(
      `Redaction failed: ${error instanceof Error ? error.message : "unknown error"}\n`,
    );
    return 1;
  }

  dependencies.write(result.text);
  // The summary goes to stderr so it can never contaminate piped output.
  if (wantsSummary) dependencies.writeError(`${formatSummary(summarizeRedaction(result))}\n`);
  return 0;
}

function formatSummary(summary: SecretRedactionSummary): string {
  const findings = summary.findings.length === 0
    ? "none"
    : summary.findings.map((finding) => `${finding.category}=${finding.count}`).join(" ");
  return [
    `redactions=${summary.redactionCount}`,
    `scanned=${summary.scannedCharacters}`,
    `truncated=${summary.truncated}`,
    `findings: ${findings}`,
  ].join(" ");
}

function readMaxCharacters(args: readonly string[]): number | null {
  const index = args.indexOf("--max-characters");
  if (index < 0) return DEFAULT_MAX_CHARACTERS;
  const raw = Number(args[index + 1]);
  if (!Number.isInteger(raw) || raw < 1 || raw > MAXIMUM_MAX_CHARACTERS) return null;
  return raw;
}

/** Reads all of stdin as UTF-8. Returns "" when stdin is closed or empty. */
export async function readStandardInput(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}
