import type { RepositoryCommandSummary } from "../domain/repository-commands.js";
import type { ValidationCommandProfile } from "../domain/validation-profile.js";
import type { ValidationComparison, ValidationKind } from "../domain/validation-result.js";

/**
 * Categories worth running to verify a code change, cheapest-and-most-specific
 * first so an obvious type error surfaces before a slow test suite does.
 *
 * "format" is deliberately excluded: formatter scripts are frequently write
 * mode rather than check mode, and running one would silently rewrite files
 * underneath the agent's own edits. "dev" and "other" are excluded because
 * they are long-running or unclassifiable.
 */
const VERIFIABLE_CATEGORIES = ["typecheck", "lint", "build", "test"] as const;
type VerifiableCategory = (typeof VERIFIABLE_CATEGORIES)[number];

/**
 * A script name comes from repository content, and it lands in an argv array
 * passed to npm. An argument beginning with "-" would be parsed by npm as a
 * *flag* rather than a script name, which turns a hostile package.json into
 * argument injection against our own package manager (`--registry=...`,
 * `--prefix=...`). Names must therefore look like names.
 */
const SAFE_SCRIPT_NAME = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;
const MAX_SCRIPT_NAME_LENGTH = 128;

const DEFAULT_MAX_PROFILES = 6;

export interface VerificationPlanOptions {
  /** Fixed executable used to run detected scripts. Never taken from repository content. */
  readonly packageManager?: string;
  readonly maxProfiles?: number;
  readonly cwd?: string;
}

export interface VerificationPlan {
  readonly profiles: readonly ValidationCommandProfile[];
  /** True when nothing runnable was found; callers must report "unverified", never "passed". */
  readonly skipped: boolean;
  readonly skipReason: string | null;
}

function toValidationKind(category: VerifiableCategory): ValidationKind {
  return category;
}

function isVerifiable(category: string): category is VerifiableCategory {
  return (VERIFIABLE_CATEGORIES as readonly string[]).includes(category);
}

/**
 * Turns detected repository commands into explicit validation profiles.
 *
 * This deliberately preserves the trust boundary documented on
 * `RepositoryCommandDetector` and `ValidationCommandProfile`: the *body* of a
 * detected script is never executed by Atlas and never reaches a shell. Only
 * a fixed executable (the package manager) is invoked, with a validated
 * script *name* as an argument — exactly what a developer typing `npm run
 * test` would do. Whatever that script then runs is the repository's own
 * business, executed by the package manager inside whatever sandbox the
 * caller established, not spliced into a command line by us.
 *
 * Only package.json scripts are considered. Makefile targets and pyproject
 * entry points are detected by the same detector but are NOT planned here,
 * because `make` and the relevant Python toolchain are frequently absent from
 * the environment and a missing executable produces an infrastructure failure
 * that muddies the baseline comparison rather than a useful signal.
 */
export function planVerification(
  summary: RepositoryCommandSummary,
  options: VerificationPlanOptions = {},
): VerificationPlan {
  const packageManager = options.packageManager ?? "npm";
  const maxProfiles = options.maxProfiles ?? DEFAULT_MAX_PROFILES;

  const candidates = summary.commands.filter(
    (command) =>
      command.source === "package.json" &&
      isVerifiable(command.category) &&
      command.name.length <= MAX_SCRIPT_NAME_LENGTH &&
      SAFE_SCRIPT_NAME.test(command.name),
  );

  const byCategory = new Map<VerifiableCategory, string[]>();
  for (const command of candidates) {
    if (!isVerifiable(command.category)) continue;
    const names = byCategory.get(command.category) ?? [];
    names.push(command.name);
    byCategory.set(command.category, names);
  }

  const profiles: ValidationCommandProfile[] = [];
  for (const category of VERIFIABLE_CATEGORIES) {
    for (const name of (byCategory.get(category) ?? []).sort()) {
      if (profiles.length >= maxProfiles) break;
      profiles.push({
        id: `${category}:${name}`,
        kind: toValidationKind(category),
        executable: packageManager,
        args: ["run", name],
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      });
    }
  }

  if (profiles.length === 0) {
    return {
      profiles: [],
      skipped: true,
      skipReason:
        "No runnable build, test, typecheck, or lint script was found in package.json, so this change could not be verified.",
    };
  }
  return { profiles, skipped: false, skipReason: null };
}

export type VerificationAction = "accept" | "repair" | "regressed" | "inconclusive";

/**
 * Maps a baseline-vs-post-change comparison plus the attempt budget onto the
 * next action.
 *
 * `compareValidationSnapshots` already distinguishes failures the change
 * introduced from failures that were already there — that distinction is the
 * whole point. Atlas only ever asks the model to repair diagnostics
 * classified "new"; a repository whose suite was already red does not become
 * the agent's problem, and does not block its pull request.
 */
export function decideVerificationAction(
  comparison: ValidationComparison,
  attemptsUsed: number,
  maxAttempts: number,
): VerificationAction {
  if (comparison.exitRecommendation === "accept") return "accept";
  if (comparison.exitRecommendation === "rerun") return "inconclusive";
  return attemptsUsed < maxAttempts ? "repair" : "regressed";
}

const MAX_REPORTED_FAILURES = 20;
const MAX_FAILURE_TEXT = 8_000;

/**
 * Renders only the newly-introduced diagnostics as text for a repair turn.
 *
 * Pre-existing and fixed diagnostics are excluded on purpose: including them
 * invites the model to "fix" unrelated pre-existing breakage, which widens
 * the change beyond what was asked and makes the pull request unreviewable.
 */
export function describeNewFailures(comparison: ValidationComparison): string {
  const introduced = comparison.diagnostics.filter((item) => item.classification === "new");
  if (introduced.length === 0) return "";

  const lines = introduced.slice(0, MAX_REPORTED_FAILURES).map((item) => {
    const location = [item.diagnostic.path, item.diagnostic.line, item.diagnostic.column]
      .filter((part) => part !== undefined && part !== null && `${part}`.length > 0)
      .join(":");
    const where = location.length > 0 ? ` (${location})` : "";
    return `- [${item.kind}] ${item.caseId}${where}: ${item.diagnostic.message}`;
  });
  if (introduced.length > MAX_REPORTED_FAILURES) {
    lines.push(`- …and ${introduced.length - MAX_REPORTED_FAILURES} further new failure(s).`);
  }

  const body = [
    "Your previous edits introduced these validation failures, which were NOT present before your change:",
    "",
    ...lines,
    "",
    "Fix the cause of these failures. Do not modify unrelated files, do not disable, skip, or weaken a test or a check to make it pass, and do not revert the original objective.",
  ].join("\n");
  return body.length <= MAX_FAILURE_TEXT ? body : `${body.slice(0, MAX_FAILURE_TEXT)}…`;
}
