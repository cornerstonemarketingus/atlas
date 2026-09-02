import assert from "node:assert/strict";
import test from "node:test";
import {
  fetchGitHubJson,
  githubReadHeaders,
  normalizePullRequest,
  normalizeRun,
  pullRequestForBranchRequest,
  workflowRunRequest,
  workflowRunsRequest,
} from "../app/api/tasks/github-runs.mjs";

test("asks only for workflow_dispatch runs of one workflow, with a bounded page size", () => {
  const request = workflowRunsRequest({ token: "t", repository: "cornerstonemarketingus/atlas", workflow: "atlas-coder.yml", perPage: 500 });
  assert.equal(
    request.url,
    "https://api.github.com/repos/cornerstonemarketingus/atlas/actions/workflows/atlas-coder.yml/runs?event=workflow_dispatch&per_page=100",
  );
  assert.equal(request.init.method, "GET");
  assert.deepEqual(request.init.headers, githubReadHeaders("t"));
  assert.equal(request.init.headers.authorization, "Bearer t");
  assert.equal(request.init.headers["x-github-api-version"], "2022-11-28");
});

test("rejects an unsafe workflow, repository, run id, or branch instead of building a URL", () => {
  assert.throws(() => workflowRunsRequest({ token: "t", repository: "cornerstonemarketingus/atlas", workflow: "../../secrets" }));
  assert.throws(() => workflowRunsRequest({ token: "t", repository: "not-a-repository", workflow: "atlas-runner.yml" }));
  assert.throws(() => workflowRunRequest({ token: "t", repository: "owner/repo", runId: "12; DROP" }));
  assert.throws(() => workflowRunRequest({ token: "t", repository: "owner/repo", runId: -1 }));
  assert.throws(() => pullRequestForBranchRequest({ token: "t", repository: "owner/repo", branch: "" }));
});

test("looks a single run up by id", () => {
  const request = workflowRunRequest({ token: "t", repository: "owner/repo", runId: 4242 });
  assert.equal(request.url, "https://api.github.com/repos/owner/repo/actions/runs/4242");
});

test("looks a pull request up by the coder task's deterministic head branch", () => {
  const request = pullRequestForBranchRequest({ token: "t", repository: "owner/repo", branch: "atlas/task-abc" });
  assert.equal(request.url, "https://api.github.com/repos/owner/repo/pulls?head=owner%3Aatlas%2Ftask-abc&state=all&per_page=1");
});

test("keeps only the run fields the dashboard needs", () => {
  assert.deepEqual(
    normalizeRun({ id: 9, created_at: "2026-09-01T12:00:00Z", event: "workflow_dispatch", status: "completed", conclusion: "success", html_url: "https://github.com/o/r/actions/runs/9", secrets: "nope" }),
    { id: 9, createdAt: "2026-09-01T12:00:00Z", event: "workflow_dispatch", status: "completed", conclusion: "success", htmlUrl: "https://github.com/o/r/actions/runs/9" },
  );
  assert.equal(normalizeRun(null), null);
  assert.equal(normalizeRun({ id: "9" }), null);
  assert.deepEqual(normalizeRun({ id: 9 }), { id: 9, createdAt: null, event: null, status: null, conclusion: null, htmlUrl: null });
});

test("reports a pull request's merge state from merged_at", () => {
  assert.deepEqual(
    normalizePullRequest({ number: 3, html_url: "https://github.com/o/r/pull/3", state: "closed", merged_at: "2026-09-01T13:00:00Z" }),
    { number: 3, url: "https://github.com/o/r/pull/3", state: "closed", merged: true },
  );
  assert.deepEqual(
    normalizePullRequest({ number: 4, html_url: "https://github.com/o/r/pull/4", state: "open", merged_at: null }),
    { number: 4, url: "https://github.com/o/r/pull/4", state: "open", merged: false },
  );
  assert.equal(normalizePullRequest(undefined), null);
});

test("degrades every GitHub read failure to null rather than throwing", async () => {
  const request = { url: "https://api.github.com/x", init: { method: "GET", headers: {} } };
  assert.equal(await fetchGitHubJson(request, async () => new Response("nope", { status: 403 })), null);
  assert.equal(await fetchGitHubJson(request, async () => { throw new Error("network down"); }), null);
  assert.equal(await fetchGitHubJson(request, async () => new Response("not json", { status: 200 })), null);
  assert.deepEqual(await fetchGitHubJson(request, async () => Response.json({ ok: true })), { ok: true });
});

test("aborts a GitHub read that hangs", async () => {
  let aborted = false;
  const result = await fetchGitHubJson(
    { url: "https://api.github.com/x", init: { method: "GET", headers: {} } },
    (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => { aborted = true; reject(new Error("aborted")); });
      }),
    10,
  );
  assert.equal(result, null);
  assert.equal(aborted, true);
});
