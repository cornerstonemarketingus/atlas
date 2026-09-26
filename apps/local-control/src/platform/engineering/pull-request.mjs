import { decideMergeAction } from "../../../../../scripts/runner/merge-decision.mjs";
import { redactText } from "./review.mjs";

/**
 * Pull-request preparation adapter (blueprint §7).
 *
 * Builds a PR payload from recorded evidence and hands it to an injected
 * `createPullRequest(payload)`. This module has no merge operation: there is
 * nothing here that could merge a PR, enable auto-merge, or push to a base
 * branch. The merge verdict reuses `decideMergeAction` from
 * scripts/runner/merge-decision.mjs only to *report* what the operator's
 * policy would allow elsewhere; the result for this module is always that a
 * human reviews the PR.
 */
export class PullRequestError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "PullRequestError";
    this.code = code;
  }
}

export const HUMAN_REVIEW_REQUIRED = "human_review_required";

/**
 * @param {string} requestedPolicy  "manual" | "ci-gated" | "none"
 * @param {{name: string, passed: boolean}[]} checks  local check results
 * @param {{regressed?: boolean, blocked?: boolean}} [signals]
 */
export function evaluateMergePolicy(requestedPolicy, checks, { regressed = false, blocked = false } = {}) {
  const policy = ["manual", "ci-gated", "none"].includes(requestedPolicy) ? requestedPolicy : "manual";
  const checkRuns = checks.map((check) => ({ status: "completed", conclusion: check.passed ? "success" : "failure" }));
  const policyDecision = decideMergeAction(policy, checkRuns);
  const reasons = ["The engineering workflow never merges; a human reviews every pull request it prepares."];
  if (regressed) reasons.push("Checks failed on the prepared change.");
  if (blocked) reasons.push("Review findings require attention.");
  if (policy !== requestedPolicy) reasons.push(`Unknown policy '${String(requestedPolicy).slice(0, 40)}' treated as 'manual'.`);
  return {
    result: HUMAN_REVIEW_REQUIRED,
    requestedPolicy: policy,
    policyDecision,
    mergeActionAvailable: false,
    reasons,
  };
}

function fence(text, limit = 1_500) {
  const value = redactText(text).trimEnd();
  const clipped = value.length > limit ? `…${value.slice(-limit)}` : value;
  return ["```", clipped.replace(/```/g, "ˋˋˋ"), "```"].join("\n");
}

/**
 * Builds the payload. `evidence.checks` entries are
 * `{ scope, name, argv, exitCode, passed, testCounts, stdout, stderr }`.
 */
export function buildPullRequestPayload({
  taskId, objective, acceptanceCriteria, head, base, diff, checks, integrationChecks = [],
  reviewFindings = {}, securityFindings = [], overlaps = [], mergePolicy,
}) {
  if (!Array.isArray(acceptanceCriteria) || acceptanceCriteria.length === 0) {
    throw new PullRequestError("NO_ACCEPTANCE_CRITERIA", "A pull request needs acceptance criteria.");
  }
  const summary = String(objective ?? "Atlas engineering task").split("\n")[0].trim();
  const title = `Atlas: ${summary.slice(0, 72)}`;
  const allChecks = [...checks, ...integrationChecks];
  const checkLine = (check) => `| ${check.scope} | \`${check.argv.join(" ")}\` | ${check.exitCode ?? "n/a"} | ${check.testCounts ? `${check.testCounts.pass}/${check.testCounts.tests} pass, ${check.testCounts.fail} fail` : "—"} | ${check.passed ? "passed" : "FAILED"} |`;
  const body = [
    redactText(objective ?? "").trim(),
    "",
    "## Acceptance criteria",
    ...acceptanceCriteria.map((criterion) => `- [ ] ${redactText(criterion)}`),
    "",
    "## Changes",
    `${diff.totals.files} file(s), +${diff.totals.added} −${diff.totals.deleted}`,
    ...diff.files.map((file) => `- \`${file.path}\` ${file.binary ? "(binary)" : `+${file.added} −${file.deleted}`}`),
    "",
    "## Evidence (exit codes and test counts from the commands themselves)",
    "| Scope | Command | Exit | Tests | Result |",
    "|---|---|---|---|---|",
    ...allChecks.map(checkLine),
    ...allChecks.flatMap((check) => ["", `<details><summary>${check.scope}: ${check.argv.join(" ")} (exit ${check.exitCode})</summary>`, "", fence(`${check.stdout ?? ""}${check.stderr ? `\n${check.stderr}` : ""}`), "</details>"]),
    "",
    "## Review",
    overlaps.length ? `Files touched by more than one agent (merged three-way, review carefully): ${overlaps.map((item) => `\`${item.path}\` (${item.roles.join(", ")})`).join(", ")}` : "No file was touched by more than one agent.",
    securityFindings.length
      ? ["Security scan flagged:", ...securityFindings.map((finding) => `- ${finding.rule} in \`${finding.path}:${finding.line}\` — ${finding.message}`)].join("\n")
      : "Security scan: no flagged constructs.",
    reviewFindings.forbidden?.length ? `Forbidden paths changed: ${reviewFindings.forbidden.map((item) => item.path).join(", ")}` : "No forbidden paths changed.",
    "",
    "## Merge",
    `Policy result: **${mergePolicy.result}** (requested policy '${mergePolicy.requestedPolicy}', policy decision '${mergePolicy.policyDecision}'). Atlas has not merged and cannot merge this pull request.`,
    "",
    `_Prepared by the Atlas engineering workflow for task ${taskId}._`,
  ].join("\n");

  return Object.freeze({
    title,
    head,
    base,
    body,
    draft: false,
    maintainerCanModify: true,
    labels: ["atlas", "needs-human-review"],
    acceptanceCriteria: [...acceptanceCriteria],
    mergePolicy,
  });
}

const FORBIDDEN_PAYLOAD_KEYS = ["merge", "autoMerge", "auto_merge", "mergeMethod", "merge_method"];

/**
 * Hands the payload to the injected `createPullRequest`. Refuses payloads
 * that ask for any merge behaviour, and refuses to report a PR that the
 * adapter claims was merged — that would mean something merged behind the
 * workflow's back.
 */
export async function submitPullRequest(payload, createPullRequest) {
  if (typeof createPullRequest !== "function") throw new PullRequestError("NO_ADAPTER", "createPullRequest must be a function.");
  for (const key of FORBIDDEN_PAYLOAD_KEYS) {
    if (Object.hasOwn(payload, key)) throw new PullRequestError("MERGE_NOT_ALLOWED", `Payload field '${key}' is not allowed.`);
  }
  if (payload.mergePolicy?.result !== HUMAN_REVIEW_REQUIRED) throw new PullRequestError("MERGE_NOT_ALLOWED", "Every prepared pull request requires human review.");
  const result = await createPullRequest(structuredClone({ ...payload }));
  if (result && (result.merged === true || result.state === "merged")) {
    throw new PullRequestError("UNEXPECTED_MERGE", "The pull-request adapter reported a merge; the workflow never requests one.");
  }
  return { url: result?.url ?? result?.html_url ?? null, number: result?.number ?? null, state: result?.state ?? "open" };
}
