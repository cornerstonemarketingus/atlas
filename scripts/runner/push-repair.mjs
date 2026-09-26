import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { redact, stewardMarker } from "./steward.mjs";

/**
 * After the coder ran on a pull request's branch: commit and push its fix to
 * that same branch (never a new pull request, never a force-push), then leave
 * one comment saying what changed and how it was validated. An attempt that
 * changed nothing still leaves a marked comment, so it counts toward the
 * attempt limit and the loop cannot spin.
 */

const outputDirectory = process.env.ATLAS_OUTPUT_DIR;
const repositoryRoot = process.env.ATLAS_REPOSITORY_ROOT;
const repository = process.env.ATLAS_REPOSITORY;
const branch = process.env.ATLAS_BRANCH;
const token = process.env.GITHUB_TOKEN;
const pullNumber = Number(process.env.ATLAS_PR_NUMBER);
const attempt = Number(process.env.ATLAS_REPAIR_ATTEMPT);
const headSha = process.env.ATLAS_HEAD_SHA ?? "";
if (!outputDirectory || !repositoryRoot || !repository || !branch || !token || !pullNumber || !attempt) {
  throw new Error("ATLAS_OUTPUT_DIR, ATLAS_REPOSITORY_ROOT, ATLAS_REPOSITORY, ATLAS_BRANCH, GITHUB_TOKEN, ATLAS_PR_NUMBER and ATLAS_REPAIR_ATTEMPT are required");
}

function readJson(name) {
  try { return JSON.parse(fs.readFileSync(path.join(outputDirectory, name), "utf8")); } catch { return null; }
}

function git(args) {
  const result = spawnSync("git", args, { cwd: repositoryRoot, encoding: "utf8", timeout: 60_000, windowsHide: true });
  if (result.error || result.status !== 0) throw new Error(`git ${args[0]} failed: ${redact(result.stderr || result.stdout || result.error?.message || "")}`);
  return result.stdout ?? "";
}

async function comment(body) {
  const response = await fetch(`https://api.github.com/repos/${repository}/issues/${pullNumber}/comments`, {
    method: "POST",
    headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "content-type": "application/json", "user-agent": "atlas-pr-steward", "x-github-api-version": "2022-11-28" },
    body: JSON.stringify({ body }),
  });
  if (!response.ok) console.log(`Could not comment on #${pullNumber}: HTTP ${response.status}`);
}

const marker = stewardMarker({ attempt, kind: "repair", headSha });
const status = readJson("status.json");
const code = readJson("code.json");
const edits = Array.isArray(code?.edits) ? code.edits : [];

if (status?.status !== "completed" || edits.length === 0) {
  const why = status?.status !== "completed" ? `the coder run ended '${status?.status ?? "unknown"}'${status?.message ? `: ${redact(status.message).slice(0, 400)}` : ""}` : "it found no change to make";
  await comment(`**Atlas PR steward — attempt ${attempt}:** no fix pushed; ${why}.\n\n${marker}`);
  console.log(`Attempt ${attempt}: nothing pushed (${why}).`);
  process.exit(0);
}

const summary = redact(String(code.summary ?? "Repair").trim());
git(["config", "user.name", "Atlas"]);
git(["config", "user.email", "atlas@users.noreply.github.com"]);
git(["add", "-A"]);
git(["commit", "-m", `Atlas repair attempt ${attempt}: ${summary.split("\n")[0].slice(0, 60)}`, "-m", summary]);
try {
  // Not a force-push: if the branch moved since planning, this is rejected and nothing is overwritten.
  git(["push", `https://x-access-token:${token}@github.com/${repository}.git`, `HEAD:refs/heads/${branch}`]);
} catch (error) {
  await comment(`**Atlas PR steward — attempt ${attempt}:** the fix was ready but the branch moved while it ran, so nothing was pushed. The next CI run will decide again.\n\n${marker}`);
  throw error;
}

const verification = code.verification ?? null;
const verdict = verification ? `Validation: **${verification.status}**${verification.message ? ` — ${redact(verification.message).slice(0, 300)}` : ""}` : "Validation: not reported.";
await comment([
  `**Atlas PR steward — attempt ${attempt}:** pushed a fix to \`${branch}\`.`,
  "",
  summary.slice(0, 1500),
  "",
  "Files changed:",
  ...edits.slice(0, 20).map((edit) => `- ${edit.operation} \`${edit.path}\``),
  "",
  verdict,
  "CI will run again on the new commit; if it is still red, the steward tries again (up to 3 attempts).",
  "",
  marker,
].join("\n"));
console.log(`Attempt ${attempt}: pushed ${edits.length} file change(s) to ${branch}.`);
