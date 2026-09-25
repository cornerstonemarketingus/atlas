import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { decideMergeAction } from "./merge-decision.mjs";
import { correlationFooter, correlationIdFromEnv, correlationLogSuffix } from "./correlation.mjs";
import { isDraftPullRequest } from "./pull-request-policy.mjs";

const outputDirectory = process.env.ATLAS_OUTPUT_DIR;
if (!outputDirectory) throw new Error("ATLAS_OUTPUT_DIR is required");
const repositoryRoot = process.env.ATLAS_REPOSITORY_ROOT;
if (!repositoryRoot) throw new Error("ATLAS_REPOSITORY_ROOT is required");
const repository = process.env.ATLAS_REPOSITORY;
const baseBranch = process.env.ATLAS_BRANCH;
const taskId = process.env.ATLAS_TASK_ID;
const githubToken = process.env.GITHUB_TOKEN;
if (!repository || !baseBranch || !taskId || !githubToken) {
  throw new Error("ATLAS_REPOSITORY, ATLAS_BRANCH, ATLAS_TASK_ID, and GITHUB_TOKEN are all required");
}
const mergePolicy = process.env.ATLAS_MERGE_POLICY ?? "manual";
const correlationId = correlationIdFromEnv();
const draftPullRequest = isDraftPullRequest(mergePolicy);

// How long ci-gated polls the head commit's check-runs before giving up and
// leaving the PR open. Comfortably inside the job's own 25-minute timeout,
// so this always exits cleanly instead of being force-killed mid-attempt.
const CI_POLL_INTERVAL_MS = 15_000;
const CI_POLL_TIMEOUT_MS = 8 * 60 * 1000;

function readJson(filename) {
  try {
    return JSON.parse(fs.readFileSync(path.join(outputDirectory, filename), "utf8"));
  } catch {
    return null;
  }
}

function writeStatus(status, message, extra = {}) {
  fs.writeFileSync(
    path.join(outputDirectory, "status.json"),
    `${JSON.stringify({ schema_version: 1, status, message, task_id: taskId, ...(correlationId ? { correlation_id: correlationId } : {}), ...extra }, null, 2)}\n`,
    { mode: 0o600 },
  );
}

const status = readJson("status.json");
const code = readJson("code.json");

if (status?.status !== "completed") {
  console.log(`Skipping pull request: coder task status was '${status?.status ?? "unknown"}', not 'completed'.`);
  process.exit(0);
}
if (!code || !Array.isArray(code.edits) || code.edits.length === 0) {
  console.log("Skipping pull request: the coder task made no file edits.");
  process.exit(0);
}

function run(label, command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: repositoryRoot, encoding: "utf8", timeout: 60_000, windowsHide: true, ...options });
  if (result.error || result.status !== 0) {
    const detail = result.stderr || result.stdout || result.error?.message || "unknown error";
    throw new Error(`${label} failed: ${detail}`);
  }
  return result.stdout ?? "";
}

const branchName = `atlas/task-${taskId}`;
run("git checkout -b", "git", ["checkout", "-b", branchName]);
run("git config user.name", "git", ["config", "user.name", "Atlas"]);
run("git config user.email", "git", ["config", "user.email", "atlas@users.noreply.github.com"]);
run("git add", "git", ["add", "-A"]);

const summary = (code.summary ?? "Atlas coder task").trim();
const title = `Atlas: ${summary.split("\n")[0].slice(0, 72)}`;
const editList = code.edits.map((edit) => `- ${edit.operation} \`${edit.path}\``).join("\n");

// Every Atlas pull request states plainly whether the change was actually
// checked against the repository's own build/test commands, and says
// "not verified" rather than staying silent when it wasn't.
const verification = code.verification ?? null;
const VERDICT_HEADLINE = {
  verified: "✅ Verified — the repository's own checks pass, and this change introduced no new failures.",
  regressed: "❌ Regressed — this change introduced validation failures that Atlas could not repair.",
  inconclusive: "⚠️ Inconclusive — the checks could not be compared reliably.",
  unverified: "⚠️ Not verified — Atlas could not run this repository's checks.",
  "not-applicable": "ℹ️ Not applicable — there was nothing to verify.",
};
const verificationSection = verification
  ? [
      "",
      "## Validation",
      VERDICT_HEADLINE[verification.status] ?? `Verification status: ${verification.status}`,
      "",
      verification.message,
      ...(verification.checks?.length ? ["", `Checks run: ${verification.checks.map((check) => `\`${check}\``).join(", ")}`] : []),
      ...(verification.attempts > 1 ? [`Repair passes: ${verification.attempts - 1}`] : []),
      ...(verification.newFailures?.length
        ? ["", "Failures introduced by this change:", ...verification.newFailures.slice(0, 10).map((failure) => `- ${failure}`)]
        : []),
    ]
  : ["", "## Validation", "⚠️ Not verified — this run predates validation reporting."];

const body = [
  summary,
  "",
  "## Files changed",
  editList,
  ...verificationSection,
  "",
  "_Opened automatically by Atlas._",
  ...correlationFooter(correlationId),
].join("\n");

run("git commit", "git", ["commit", "-m", title, "-m", summary]);

const [owner, repo] = repository.split("/");
const remoteUrl = `https://x-access-token:${githubToken}@github.com/${owner}/${repo}.git`;
run("git push", "git", ["push", remoteUrl, `HEAD:${branchName}`]);

const githubApiHeaders = {
  accept: "application/vnd.github+json",
  authorization: `Bearer ${githubToken}`,
  "user-agent": "atlas-control-plane",
  "x-github-api-version": "2022-11-28",
};

const createResponse = await fetch(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls`, {
  method: "POST",
  headers: { ...githubApiHeaders, "content-type": "application/json" },
  body: JSON.stringify({ title, head: branchName, base: baseBranch, body, draft: draftPullRequest }),
});

if (!createResponse.ok) {
  const detail = await createResponse.text().catch(() => "");
  writeStatus("failed", `Pushed branch ${branchName} but pull request creation failed: HTTP ${createResponse.status}.`);
  throw new Error(`Pull request creation failed: HTTP ${createResponse.status} ${detail.slice(0, 500)}`);
}

const pullRequest = await createResponse.json();
console.log(`Opened ${draftPullRequest ? "draft " : ""}pull request: ${pullRequest.html_url ?? "(no URL returned)"}${correlationLogSuffix(correlationId)}`);

async function fetchCheckRuns(ref) {
  const response = await fetch(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${ref}/check-runs`, {
    headers: githubApiHeaders,
  });
  if (!response.ok) throw new Error(`Fetching check runs failed: HTTP ${response.status}`);
  const value = await response.json();
  return Array.isArray(value.check_runs) ? value.check_runs.map((run_) => ({ status: run_.status, conclusion: run_.conclusion })) : [];
}

async function mergePullRequest(pullNumber) {
  const response = await fetch(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${pullNumber}/merge`, {
    method: "PUT",
    headers: { ...githubApiHeaders, "content-type": "application/json" },
    body: JSON.stringify({ merge_method: "squash" }),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    return { merged: false, detail: detail.slice(0, 500) };
  }
  const value = await response.json();
  return { merged: value.merged === true, detail: value.message ?? "" };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Polls the head commit's check-runs until decideMergeAction returns
 * something other than "wait", or the timeout elapses — at which point a
 * repository with slow CI and one with no CI configured at all are treated
 * identically: neither gets an unreviewed merge into main.
 */
async function waitForCiOutcome(headSha) {
  const deadline = Date.now() + CI_POLL_TIMEOUT_MS;
  for (;;) {
    const checkRuns = await fetchCheckRuns(headSha);
    const action = decideMergeAction("ci-gated", checkRuns);
    if (action !== "wait") return action;
    if (Date.now() >= deadline) return "hold";
    await sleep(CI_POLL_INTERVAL_MS);
  }
}

// A regressed verification means Atlas *knows* this change broke checks that
// passed before it. "none" means "don't wait for CI" — it does not mean
// "merge code we already measured as broken", so a regression overrides the
// policy in the safe direction. Weaker signals (unverified, inconclusive) do
// NOT override it: absence of evidence is the bar the operator already chose
// when they selected their policy, and silently overriding that would make
// the setting untrustworthy.
if (verification?.status === "regressed" && mergePolicy !== "manual") {
  const message = `Opened a pull request but did NOT auto-merge it despite the '${mergePolicy}' policy: verification found ${verification.newFailures?.length ?? 0} failure(s) this change introduced. ${verification.message}`;
  writeStatus("completed", message, { pull_request_url: pullRequest.html_url ?? null, merged: false, verification });
  console.log(message);
} else if (mergePolicy === "none") {
  const result = await mergePullRequest(pullRequest.number);
  const message = result.merged
    ? "Opened and auto-merged the pull request (merge policy: none)."
    : `Opened the pull request, but the immediate auto-merge failed: ${result.detail || "no reason given"}. Left open for review.`;
  writeStatus("completed", message, { pull_request_url: pullRequest.html_url ?? null, merged: result.merged, ...(verification ? { verification } : {}) });
  console.log(message);
} else if (mergePolicy === "ci-gated") {
  console.log("Merge policy is ci-gated — waiting for checks on the pull request's head commit...");
  const action = await waitForCiOutcome(pullRequest.head.sha);
  if (action === "merge-now") {
    const result = await mergePullRequest(pullRequest.number);
    const message = result.merged
      ? "Opened and auto-merged the pull request once CI passed (merge policy: ci-gated)."
      : `CI passed, but auto-merge failed: ${result.detail || "no reason given"}. Left open for review.`;
    writeStatus("completed", message, { pull_request_url: pullRequest.html_url ?? null, merged: result.merged });
    console.log(message);
  } else {
    const message = "Opened a pull request for review. Left it open — CI either failed or didn't finish within the wait window (merge policy: ci-gated); a repository with no CI configured is held the same way, deliberately.";
    writeStatus("completed", message, { pull_request_url: pullRequest.html_url ?? null, merged: false });
    console.log(message);
  }
} else {
  const message = `${draftPullRequest ? "Opened a draft pull request for review." : "Opened a pull request for review."} Nothing has been merged.`;
  writeStatus("completed", message, { pull_request_url: pullRequest.html_url ?? null, merged: false, draft: draftPullRequest, ...(verification ? { verification } : {}) });
  console.log(message);
}
