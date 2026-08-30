import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

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
    `${JSON.stringify({ schema_version: 1, status, message, task_id: taskId, ...extra }, null, 2)}\n`,
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
const body = [summary, "", "## Files changed", editList, "", "_Opened automatically by Atlas. Nothing here has been merged — review before merging._"].join("\n");

run("git commit", "git", ["commit", "-m", title, "-m", summary]);

const [owner, repo] = repository.split("/");
const remoteUrl = `https://x-access-token:${githubToken}@github.com/${owner}/${repo}.git`;
run("git push", "git", ["push", remoteUrl, `HEAD:${branchName}`]);

const response = await fetch(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls`, {
  method: "POST",
  headers: {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${githubToken}`,
    "content-type": "application/json",
    "user-agent": "atlas-control-plane",
    "x-github-api-version": "2022-11-28",
  },
  body: JSON.stringify({ title, head: branchName, base: baseBranch, body }),
});

if (!response.ok) {
  const detail = await response.text().catch(() => "");
  writeStatus("failed", `Pushed branch ${branchName} but pull request creation failed: HTTP ${response.status}.`);
  throw new Error(`Pull request creation failed: HTTP ${response.status} ${detail.slice(0, 500)}`);
}

const pullRequest = await response.json();
writeStatus("completed", "Opened a pull request for review. Nothing has been merged.", { pull_request_url: pullRequest.html_url ?? null });
console.log(`Opened pull request: ${pullRequest.html_url ?? "(no URL returned)"}`);
