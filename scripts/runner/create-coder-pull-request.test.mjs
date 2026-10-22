import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./create-coder-pull-request.mjs", import.meta.url));

// Exercise real staging, commit and push against a local bare repository.
// Only GitHub HTTP calls and the destination of `git push` are substituted.
async function fixture(t, scenario, policy = "ci-gated") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-pr-smoke-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repository = path.join(root, "target");
  const output = path.join(root, "output");
  const remote = path.join(root, "remote.git");
  fs.mkdirSync(repository);
  fs.mkdirSync(output);
  function git(args, cwd = repository) {
    const result = spawnSync("git", args, { cwd, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  }
  git(["init", "--initial-branch=main"]);
  git(["config", "user.name", "Fixture"]);
  git(["config", "user.email", "fixture@example.invalid"]);
  fs.writeFileSync(path.join(repository, "example.txt"), "before\n");
  git(["add", "."]);
  git(["commit", "-m", "baseline"]);
  git(["init", "--bare", remote]);
  fs.writeFileSync(path.join(repository, "example.txt"), "after\n");
  fs.writeFileSync(path.join(output, "status.json"), JSON.stringify({ status: "completed" }));
  fs.writeFileSync(path.join(output, "code.json"), JSON.stringify({
    summary: "Update the example", edits: [{ operation: "modified", path: "example.txt" }],
    verification: { status: "verified", message: "Tests passed", checks: ["test"] },
  }));
  const preload = path.join(root, "github-fixture.mjs");
  fs.writeFileSync(preload, `
import cp from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";
const original = cp.spawnSync;
cp.spawnSync = (command, args, options) => original(command,
  command === "git" && args[0] === "push" ? ["push", process.env.FIXTURE_REMOTE, args[2]] : args, options);
syncBuiltinESMExports();
const scenario = process.env.FIXTURE_SCENARIO;
const calls = process.env.FIXTURE_CALLS;
const success = { status: "completed", conclusion: "success" };
const failure = { status: "completed", conclusion: "failure" };
const sha = () => original("git", ["rev-parse", "HEAD"], {cwd:process.env.ATLAS_REPOSITORY_ROOT,encoding:"utf8"}).stdout.trim();
globalThis.fetch = async (input, options = {}) => {
  const url = new URL(input);
  const body = options.body ? JSON.parse(options.body) : null;
  const receipt = JSON.parse(fs.readFileSync(path.join(process.env.ATLAS_OUTPUT_DIR, "status.json"), "utf8"));
  fs.appendFileSync(calls, JSON.stringify({ path: url.pathname, search: url.search, method: options.method || "GET", body, receipt }) + "\\n");
  if (url.pathname.endsWith("/pulls") && options.method === "POST") {
    if (scenario === "create-fail") return new Response("secret response " + process.env.GITHUB_TOKEN, { status: 403 });
    return Response.json({ number: 7, html_url: "https://github.com/fixture/repo/pull/7", head: { sha: sha() } });
  }
  if (url.pathname.endsWith("/check-runs")) {
    if (scenario === "check-http-fail") return new Response(process.env.GITHUB_TOKEN, { status: 503 });
    if (scenario === "incomplete-checks") return Response.json({ check_runs: [success] });
    if (scenario === "second-page-fail") return Response.json(url.searchParams.get("page") === "1"
      ? { check_runs: Array(100).fill(success), total_count: 101 }
      : { check_runs: [failure], total_count: 101 });
    return Response.json({ check_runs: [scenario === "checks-fail" ? failure : success], total_count: 1 });
  }
  if (url.pathname.endsWith("/status")) return Response.json({
    statuses: scenario === "status-fail" ? [{state:"failure"}] : [],
    total_count: scenario === "status-fail" ? 1 : 0,
  });
  if (url.pathname.endsWith("/pulls/7/merge")) {
    if (scenario === "merge-http-fail") throw new Error("secret " + process.env.GITHUB_TOKEN);
    return Response.json({ merged: true });
  }
  if (url.pathname.endsWith("/pulls/7")) return Response.json({
    state: "open", draft: false, mergeable: true,
    mergeable_state: scenario === "missing-required" ? "blocked" : "clean",
    head: { sha: scenario === "head-changed" ? "b".repeat(40) : sha() },
  });
  throw new Error("Unexpected fixture request " + url);
};
`);
  const result = spawnSync(process.execPath, ["--import", preload, script], {
    cwd: repository, encoding: "utf8", timeout: 10_000,
    env: {
      ...process.env, ATLAS_OUTPUT_DIR: output, ATLAS_REPOSITORY_ROOT: repository,
      ATLAS_REPOSITORY: "fixture/repo", ATLAS_BRANCH: "main", ATLAS_TASK_ID: "smoke",
      ATLAS_MERGE_POLICY: policy, GITHUB_TOKEN: "fixture-sensitive-token",
      FIXTURE_REMOTE: remote, FIXTURE_SCENARIO: scenario, FIXTURE_CALLS: path.join(root, "calls.jsonl"),
    },
  });
  assert.equal(result.error, undefined, String(result.error));
  assert.doesNotMatch(result.stdout + result.stderr, /fixture-sensitive-token/);
  const status = JSON.parse(fs.readFileSync(path.join(output, "status.json"), "utf8"));
  const calls = fs.readFileSync(path.join(root, "calls.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
  const head = git(["rev-parse", "HEAD"]);
  assert.equal(git(["--git-dir", remote, "show", "atlas/task-smoke:example.txt"]), "after");
  assert.equal(status.head_sha, head);
  assert.equal(status.pushed_branch, "atlas/task-smoke");
  return { result, status, calls, head };
}

test("coding smoke stages the actual change, pushes a commit, opens a PR and merges its passing head", async t => {
  const { result, status, calls, head } = await fixture(t, "passed");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(status.status, "completed");
  assert.equal(status.pull_request_url, "https://github.com/fixture/repo/pull/7");
  assert.equal(status.merged, true);
  const create = calls.find(call => call.method === "POST");
  assert.equal(create.body.head, "atlas/task-smoke");
  assert.match(create.body.body, /Verified.*repository's own checks pass/);
  assert.match(create.body.body, /modified `example.txt`/);
  const merge = calls.find(call => call.method === "PUT");
  assert.equal(merge.body.sha, head);
  assert.equal(merge.receipt.pull_request_url, status.pull_request_url, "receipt is persisted before polling/merge");
});

test("manual policy opens a draft and never requests a merge", async t => {
  const { result, status, calls } = await fixture(t, "passed", "manual");
  assert.equal(result.status, 0);
  assert.equal(status.draft, true);
  assert.equal(status.merged, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.draft, true);
});

for (const scenario of ["checks-fail", "status-fail", "second-page-fail", "missing-required", "head-changed", "incomplete-checks", "check-http-fail"]) {
  test(`CI gating retains the PR and refuses unsafe merge: ${scenario}`, async t => {
    const { result, status, calls } = await fixture(t, scenario);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(status.merged, false);
    assert.equal(status.pull_request_url, "https://github.com/fixture/repo/pull/7");
    assert.equal(status.verification.status, "verified");
    assert.equal(calls.some(call => call.method === "PUT"), false);
    if (scenario === "second-page-fail") assert(calls.some(call => call.search.includes("page=2")));
  });
}

test("legacy none policy also refuses failing GitHub CI", async t => {
  const { status, calls } = await fixture(t, "checks-fail", "none");
  assert.equal(status.merged, false);
  assert.equal(calls.some(call => call.method === "PUT"), false);
});

test("failed PR creation keeps the pushed branch and exact commit for recovery", async t => {
  const { result, status } = await fixture(t, "create-fail");
  assert.equal(result.status, 1);
  assert.equal(status.status, "failed");
  assert.match(status.message, /GitHub HTTP 403/);
  assert.match(status.message, /branch atlas\/task-smoke/);
  assert.doesNotMatch(status.message, /fixture-sensitive-token/);
});

test("an interrupted merge retains its PR receipt without claiming it did not merge", async t => {
  const { result, status } = await fixture(t, "merge-http-fail");
  assert.equal(result.status, 0);
  assert.equal(status.merged, null);
  assert.match(status.message, /Merge outcome could not be confirmed/);
  assert.equal(status.pull_request_url, "https://github.com/fixture/repo/pull/7");
});
