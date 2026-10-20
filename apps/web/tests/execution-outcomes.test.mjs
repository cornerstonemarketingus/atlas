import test from "node:test";
import assert from "node:assert/strict";
import { executionOutcome, verifyExecutionOutcome } from "../app/api/tasks/execution-outcomes.mjs";
const identity = { run_id: "123", run_attempt: "1" };
const task = { repository: "cornerstonemarketingus/atlas", mode: "coder" };
const run = { head_sha: "a".repeat(40) };
const job = { id: 456, name: "run", run_id: 123, run_attempt: 1, head_sha: run.head_sha, head_branch: "main", workflow_name: "Atlas Coder", status: "completed", conclusion: "failure", completed_at: "2026-10-15T00:00:00Z" };
const page = jobs => ({ total_count: jobs.length, jobs });

test("exact completed execution job is evidence while report and workflow are still running", () => {
  const result = executionOutcome(identity, task, run, page([job, { ...job, id: 789, name: "Return results to Atlas", status: "in_progress", conclusion: null }]));
  assert.deepEqual(result, { runId: 123, runAttempt: 1, jobId: 456, headSha: run.head_sha, conclusion: "failure", completedAt: "2026-10-15T00:00:00.000Z" });
  for (const conclusion of ["success", "failure", "cancelled", "skipped", "timed_out", "action_required", "neutral", "stale", "startup_failure"]) assert.equal(executionOutcome(identity, task, run, page([{ ...job, conclusion }])).conclusion, conclusion);
  assert.equal(executionOutcome(identity, task, run, page([{ ...job, run_attempt: undefined }])).runAttempt, 1);
  assert.equal(executionOutcome(identity, { ...task, mode: "inspect" }, run, page([{ ...job, workflow_name: "Atlas Runner" }])).jobId, 456);
});

test("pending, ambiguous, foreign, stale and incomplete evidence cannot become a receipt", () => {
  for (const changes of [{ name: "report" }, { id: 0 }, { id: 1.5 }, { run_id: 124 }, { run_attempt: 2 }, { head_sha: "b".repeat(40) }, { head_branch: "feature" }, { workflow_name: "CI" }, { status: "in_progress" }, { conclusion: null }, { conclusion: "private-token" }, { completed_at: null }, { completed_at: "not-date" }, { completed_at: "2999-01-01T00:00:00Z" }]) assert.throws(() => executionOutcome(identity, task, run, page([{ ...job, ...changes }])));
  for (const jobs of [[], [job, job], [{ ...job, name: "Return results to Atlas" }]]) assert.throws(() => executionOutcome(identity, task, run, page(jobs)));
  for (const bad of [{ total_count: 101, jobs: [job] }, { total_count: 2, jobs: [job] }, { jobs: [job] }, null]) assert.throws(() => executionOutcome(identity, task, run, bad));
  assert.throws(() => executionOutcome(identity, task, { head_sha: "bad" }, page([job])));
});

test("exact attempt API uses bounded requests without credential redirects", async () => {
  let calls = 0;
  const result = await verifyExecutionOutcome(identity, task, run, "fake-private-token", async (url, options) => {
    calls++; assert.equal(url, "https://api.github.com/repos/cornerstonemarketingus/atlas/actions/runs/123/attempts/1/jobs?per_page=100");
    assert.equal(options.redirect, "manual"); assert.equal(options.headers.authorization, "Bearer fake-private-token"); assert.ok(options.signal);
    return Response.json(page([job]));
  });
  assert.equal(result.jobId, 456); assert.equal(calls, 1);
  await assert.rejects(verifyExecutionOutcome(identity, task, run, "fake-private-token", async () => new Response("private upstream error", { status: 429 })), error => !/private/.test(error.message));
});
