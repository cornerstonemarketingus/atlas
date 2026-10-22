import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { autoMergeAllowed, decideMergeAction } from "./merge-decision.mjs";
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
  const statusPath = path.join(outputDirectory, "status.json");
  const temporaryPath = `${statusPath}.${process.pid}.tmp`;
  fs.writeFileSync(
    temporaryPath,
    `${JSON.stringify({ schema_version: 1, status, message, task_id: taskId, ...(correlationId ? { correlation_id: correlationId } : {}), ...extra }, null, 2)}\n`,
    { mode: 0o600 },
  );
  fs.renameSync(temporaryPath, statusPath);
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

writeStatus("running", "Preparing the coder change for a pull request.");

function run(label, command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: repositoryRoot, encoding: "utf8", timeout: 60_000, windowsHide: true, ...options });
  if (result.error || result.status !== 0) {
    // Git may echo a credential-bearing remote URL. Report only metadata.
    const message = `${label} failed (exit ${result.status ?? "unknown"}).`;
    writeStatus("failed", message);
    throw new Error(message);
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
  passed: "✅ Verified — the repository's own checks pass, and this change introduced no new failures.",
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
const headSha = run("git rev-parse", "git", ["rev-parse", "HEAD"]).trim();
const recovery = { local_branch: branchName, head_sha: headSha, ...(verification ? { verification } : {}) };
let pullRequest;
let mergeAttempted = false;
let stage = "pushing the change";

const githubApiHeaders = {
  accept: "application/vnd.github+json",
  authorization: `Bearer ${githubToken}`,
  "user-agent": "atlas-control-plane",
  "x-github-api-version": "2022-11-28",
};
const apiRoot = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
async function api(endpoint, options = {}) {
  const response = await fetch(`${apiRoot}${endpoint}`, {
    ...options, headers: { ...githubApiHeaders, "content-type": "application/json" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`GitHub HTTP ${response.status}`);
  return response.json();
}

// Fetch every page, failing closed rather than treating a partial page as green.
async function fetchCheckRuns(ref) {
  const checks = [];
  for (let page = 1; page <= 100; page++) {
    const value = await api(`/commits/${ref}/check-runs?per_page=100&page=${page}`);
    if (!Array.isArray(value.check_runs) || !Number.isSafeInteger(value.total_count)) throw new Error("Incomplete GitHub check-runs response");
    checks.push(...value.check_runs);
    if (checks.length >= value.total_count) return checks;
    if (value.check_runs.length === 0) break;
  }
  throw new Error("Incomplete GitHub check-runs response");
}

async function fetchStatusChecks(ref) {
  const checks = [];
  for (let page = 1; page <= 100; page++) {
    const value = await api(`/commits/${ref}/status?per_page=100&page=${page}`);
    if (!Array.isArray(value.statuses) || !Number.isSafeInteger(value.total_count)) throw new Error("Incomplete GitHub status response");
    checks.push(...value.statuses.map(status => ({
      status: status.state === "pending" ? "in_progress" : "completed",
      conclusion: status.state === "success" ? "success" : status.state === "pending" ? null : "failure",
    })));
    if (checks.length >= value.total_count) return checks;
    if (value.statuses.length === 0) break;
  }
  throw new Error("Incomplete GitHub status response");
}

async function waitForCiOutcome(ref) {
  const deadline = Date.now() + CI_POLL_TIMEOUT_MS;
  for (;;) {
    const [checkRuns, statusChecks] = await Promise.all([fetchCheckRuns(ref), fetchStatusChecks(ref)]);
    const action = decideMergeAction(mergePolicy, [...checkRuns, ...statusChecks]);
    if (action !== "wait") return action;
    if (Date.now() >= deadline) return "hold";
    await new Promise(resolve => setTimeout(resolve, CI_POLL_INTERVAL_MS));
  }
}

function receipt(message, merged = false) {
  writeStatus("completed", message, {
    ...recovery, pull_request_url: pullRequest.html_url ?? null, merged, draft: draftPullRequest,
  });
  console.log(message);
}

try {
  run("git push", "git", ["push", remoteUrl, `HEAD:${branchName}`]);
  recovery.pushed_branch = branchName;
  // The pushed commit can be recovered even if PR creation never returns.
  writeStatus("running", `Pushed branch ${branchName}; opening a pull request.`, recovery);
  stage = "creating the pull request";
  pullRequest = await api("/pulls", {
    method: "POST", body: JSON.stringify({ title, head: branchName, base: baseBranch, body, draft: draftPullRequest }),
  });
  if (!Number.isSafeInteger(pullRequest.number) || pullRequest.head?.sha !== headSha) throw new Error("Unexpected pull request head");
  receipt(`${draftPullRequest ? "Opened a draft pull request" : "Opened a pull request"} for review. Nothing has been merged.${correlationLogSuffix(correlationId)}`);

  const mergeGate = autoMergeAllowed(mergePolicy, verification);
  if (!mergeGate.allowed) {
    receipt(`Opened a pull request for review. ${mergeGate.reason} Nothing has been merged.`);
  } else {
    console.log("Waiting for CI and repository merge requirements on the pull request's head commit...");
    stage = "inspecting CI";
    const action = await waitForCiOutcome(headSha);
    if (action !== "merge-now") {
      receipt("Opened a pull request for review. CI failed or did not complete within the wait window; nothing has been merged.");
    } else {
      // GitHub evaluates required checks/reviews on the PR. A partial set of
      // green checks alone is not evidence that repository requirements passed.
      stage = "inspecting repository merge requirements";
      const current = await api(`/pulls/${pullRequest.number}`);
      if (current.head?.sha !== headSha || current.state !== "open" || current.draft !== false
          || current.mergeable !== true || current.mergeable_state !== "clean") {
        receipt("Opened a pull request for review. Its head or repository merge requirements are not confirmed; nothing has been merged.");
      } else {
        // SHA precondition prevents a changed head from using stale CI evidence.
        stage = "requesting the merge";
        mergeAttempted = true;
        const result = await api(`/pulls/${pullRequest.number}/merge`, {
          method: "PUT", body: JSON.stringify({ merge_method: "squash", sha: headSha }),
        });
        receipt(result.merged === true
          ? "Opened and auto-merged the pull request after CI and repository merge requirements passed."
          : "CI passed, but GitHub did not merge the pull request. Left open for review.", result.merged === true);
      }
    }
  }
} catch (error) {
  // Never echo response bodies or arbitrary exception text: either may contain
  // credentials. The stage and HTTP status are sufficient for operator action.
  const detail = /^GitHub HTTP [0-9]{3}$/u.test(error.message ?? "") ? error.message : `failure while ${stage}`;
  if (pullRequest?.html_url) {
    receipt(mergeAttempted
      ? `Opened a pull request. Merge outcome could not be confirmed: ${detail}; inspect the pull request before retrying.`
      : `Opened a pull request for review. Automatic merge stopped: ${detail}. Nothing has been merged.`, mergeAttempted ? null : false);
  } else {
    writeStatus("failed", `Pull request creation did not finish: ${detail}. Recover the committed work from branch ${branchName}.`, recovery);
    console.error(`Pull request creation did not finish: ${detail}.`);
    process.exitCode = 1;
  }
}
