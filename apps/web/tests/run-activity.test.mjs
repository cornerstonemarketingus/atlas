import assert from "node:assert/strict";
import test from "node:test";
import { activityFromRun, runBelongsToTask } from "../app/api/tasks/run-activity.mjs";
import { createDeltaParser } from "../app/api/chat/stream.mjs";
import { taskRequestsFromCalls, upgradeForRequest } from "../app/api/chat/atlas-knowledge.mjs";

const TASK = "7e86736a-0b50-4f9a-bb9e-2094c247217e";

test("a run only belongs to the task whose id it carries in its name", () => {
  assert.equal(runBelongsToTask({ name: `Atlas Coder · task ${TASK}` }, TASK), true);
  assert.equal(runBelongsToTask({ name: "Atlas Coder · task 00000000-0000-4000-8000-000000000000" }, TASK), false);
  assert.equal(runBelongsToTask({ name: "Atlas Coder" }, TASK), false);
});

test("run steps become a readable timeline without plumbing steps", () => {
  const activity = activityFromRun({ status: "in_progress", conclusion: null, html_url: "https://github.com/x/y/actions/runs/1" }, { jobs: [{ steps: [
    { name: "Set up job", status: "completed", conclusion: "success" },
    { name: "Check the Actions minutes budget", status: "completed", conclusion: "success", started_at: "2026-09-26T10:00:00Z", completed_at: "2026-09-26T10:00:04Z" },
    { name: "Start a self-hosted model server", status: "completed", conclusion: "skipped" },
    { name: "Run Atlas task", status: "in_progress", conclusion: null, started_at: "2026-09-26T10:00:05Z" },
    { name: "Open pull request for coder changes", status: "queued", conclusion: null },
    { name: "Post Run actions/checkout@v4", status: "queued", conclusion: null },
  ] }] });
  assert.deepEqual(activity.steps.map((step) => [step.label, step.state]), [
    ["Checking the run budget", "done"],
    ["Working on it: reading, changing and testing code", "running"],
    ["Opening the pull request", "pending"],
  ]);
  assert.equal(activity.url, "https://github.com/x/y/actions/runs/1");
});

test("a failed step is reported as failed", () => {
  const activity = activityFromRun({ status: "completed", conclusion: "failure" }, { jobs: [{ steps: [{ name: "Run Atlas task", status: "completed", conclusion: "failure" }] }] });
  assert.equal(activity.steps[0].state, "failed");
});

test("thinking is collected apart from the answer", () => {
  const parser = createDeltaParser();
  const deltas = parser.push('data: {"choices":[{"delta":{"reasoning":"Look at the repo first. "}}]}\n\ndata: {"choices":[{"delta":{"content":"Here is the plan."}}]}\n\n');
  assert.deepEqual(deltas, ["Here is the plan."]);
  assert.equal(parser.drainReasoning(), "Look at the repo first. ");
  assert.equal(parser.drainReasoning(), "");
});

test("asking for a fix or a pull request always gets a coder run", () => {
  assert.equal(upgradeForRequest("inspect", "Find the most likely bug in my project, fix it, run the tests, and open a pull request."), "coder");
  assert.equal(upgradeForRequest("debug", "please open a PR for this"), "coder");
  assert.equal(upgradeForRequest("inspect", "Explain how my project is organised."), "inspect");
  assert.equal(upgradeForRequest("computer", "fix the form on example.com"), "computer");
  const { requests } = taskRequestsFromCalls([{ function: { name: "start_atlas_task", arguments: JSON.stringify({ mode: "inspect", objective: "Inspect repository for likely bugs" }) } }],
    { defaultRepository: "cornerstonemarketingus/atlas", userMessage: "Find the most likely bug in my project, fix it, run the tests, and open a pull request." });
  assert.equal(requests[0].mode, "coder");
});
