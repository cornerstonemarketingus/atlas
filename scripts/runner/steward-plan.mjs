import crypto from "node:crypto";
import fs from "node:fs";
import {
  actionableReviewFeedback, buildRepairObjective, decide, stewardComments, stewardMarker, taskIdFromBranch, trimLog,
} from "./steward.mjs";

/**
 * Plans one PR-steward run: finds the Atlas pull request that needs work
 * (from a finished CI run, a manual dispatch, or the 6-hourly sweep), gathers
 * its failing job logs and new review feedback, decides with steward.mjs,
 * and hands the workflow either a repair objective or nothing. Stop notices
 * are posted here, once per commit. Runs before any untrusted checkout.
 */

const repository = process.env.GITHUB_REPOSITORY;
const token = process.env.GITHUB_TOKEN;
if (!repository || !token) throw new Error("GITHUB_REPOSITORY and GITHUB_TOKEN are required");
const API = `https://api.github.com/repos/${repository}`;
const headers = { accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "user-agent": "atlas-pr-steward", "x-github-api-version": "2022-11-28" };

async function api(path, init = {}) {
  const response = await fetch(path.startsWith("http") ? path : `${API}${path}`, { ...init, headers: { ...headers, ...(init.headers ?? {}) } });
  if (!response.ok) throw new Error(`GitHub ${init.method ?? "GET"} ${path} answered ${response.status}`);
  return response.status === 204 ? null : response.json();
}

async function text(path) {
  const response = await fetch(`${API}${path}`, { headers });
  return response.ok ? response.text() : "";
}

function output(name, value) {
  const file = process.env.GITHUB_OUTPUT;
  const delimiter = `ATLAS_${crypto.randomBytes(12).toString("hex")}`;
  if (file) fs.appendFileSync(file, `${name}<<${delimiter}\n${value}\n${delimiter}\n`);
  else console.log(`${name}=${value}`);
}

function exportEnv(name, value) {
  const file = process.env.GITHUB_ENV;
  const delimiter = `ATLAS_${crypto.randomBytes(12).toString("hex")}`;
  if (file) fs.appendFileSync(file, `${name}<<${delimiter}\n${value}\n${delimiter}\n`);
}

const event = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH ?? "/dev/null", "utf8") || "{}");
const eventName = process.env.GITHUB_EVENT_NAME ?? "";

/** Pull requests to consider, most specific trigger first. */
async function candidates() {
  if (eventName === "workflow_run") {
    const run = event.workflow_run ?? {};
    if (run.conclusion !== "failure" || !taskIdFromBranch(run.head_branch) || run.head_repository?.full_name !== repository) return [];
    const [owner] = repository.split("/");
    const pulls = await api(`/pulls?state=open&head=${encodeURIComponent(`${owner}:${run.head_branch}`)}&per_page=1`);
    return pulls.map((pull) => ({ pull, headSha: run.head_sha }));
  }
  const requested = Number(process.env.ATLAS_PR_NUMBER || event.inputs?.pr_number || 0);
  if (requested > 0) return [{ pull: await api(`/pulls/${requested}`), headSha: null }];
  const pulls = await api("/pulls?state=open&per_page=50&sort=created&direction=asc");
  return pulls.filter((pull) => taskIdFromBranch(pull.head?.ref)).map((pull) => ({ pull, headSha: null }));
}

/** Failed GitHub Actions checks on a commit: names, and each job's trimmed log. */
async function failedChecks(sha) {
  const { check_runs: runs = [] } = await api(`/commits/${sha}/check-runs?per_page=100`);
  const failed = runs.filter((run) => run.app?.slug === "github-actions" && run.status === "completed" && ["failure", "timed_out"].includes(run.conclusion));
  return failed;
}

async function baseCheckRuns(branch) {
  try {
    const commit = await api(`/commits/${encodeURIComponent(branch)}`);
    const { check_runs: runs = [] } = await api(`/commits/${commit.sha}/check-runs?per_page=100`);
    return runs.map((run) => ({ name: run.name, status: run.status, conclusion: run.conclusion }));
  } catch {
    return [];
  }
}

async function comment(number, body) {
  await api(`/issues/${number}/comments`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ body }) });
}

let planned = null;
for (const { pull, headSha } of await candidates()) {
  const comments = await api(`/issues/${pull.number}/comments?per_page=100`);
  const history = stewardComments(comments);
  const since = history.at(-1)?.createdAt ?? pull.created_at ?? "";
  const [reviewComments, reviews] = await Promise.all([api(`/pulls/${pull.number}/comments?per_page=100`), api(`/pulls/${pull.number}/reviews?per_page=100`)]);
  const feedback = actionableReviewFeedback({ reviewComments, reviews, since });
  const failed = await failedChecks(pull.head.sha);
  const decision = decide({
    pullRequest: pull, comments, failedChecks: failed.map((run) => run.name), baseCheckRuns: await baseCheckRuns(pull.base.ref), feedback, headSha,
  });
  console.log(`#${pull.number} (${pull.head.ref}): ${decision.action} — ${decision.reason}`);
  if (decision.action === "stop") {
    await comment(pull.number, `**Atlas PR steward:** stopping. ${decision.reason}\n\n${stewardMarker({ attempt: 0, kind: "stop", headSha: pull.head.sha })}`);
    continue;
  }
  if (decision.action !== "repair") continue;
  const failures = [];
  for (const run of failed.slice(0, 3)) failures.push({ job: run.name, excerpt: trimLog(await text(`/actions/jobs/${run.id}/logs`)) });
  planned = { pull, decision, objective: buildRepairObjective({ failures, feedback, attempt: decision.attempt, pullNumber: pull.number }) };
  break;
}

if (!planned) {
  output("action", "none");
} else {
  const { pull, decision, objective } = planned;
  output("action", "repair");
  output("pr_number", String(pull.number));
  output("branch", pull.head.ref);
  output("head_sha", pull.head.sha);
  output("attempt", String(decision.attempt));
  output("reason", decision.reason);
  exportEnv("ATLAS_TASK_ID", taskIdFromBranch(pull.head.ref));
  exportEnv("ATLAS_BRANCH", pull.head.ref);
  exportEnv("ATLAS_OBJECTIVE", objective);
  console.log(`Planned repair attempt ${decision.attempt} on #${pull.number}.`);
}
