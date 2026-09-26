import assert from "node:assert/strict";
import test from "node:test";
import { allowedRepositories, dispatchGitHub, githubDispatchRequest, validateTask, workflowForMode } from "../app/api/tasks/dispatch.mjs";

const valid = { repository: "Cornerstonemarketingus/atlas", branch: "main", mode: "inspect", objective: " Map the API. " };
// Coding tasks must name something concrete to change (see assessCoderObjective).
const validCoder = { ...valid, mode: "coder", objective: "Add rate limiting to the API endpoints." };

test("validates and normalizes a task against a case-insensitive allowlist", () => {
  const result = validateTask(valid, allowedRepositories("cornerstonemarketingus/atlas"));
  assert.deepEqual(result, { task: { ...valid, repository: "cornerstonemarketingus/atlas", objective: "Map the API." } });
});

test("rejects unsafe branches, modes, objectives, and repositories", () => {
  const allowlist = allowedRepositories("cornerstonemarketingus/atlas");
  assert.equal(validateTask({ ...valid, repository: "other/repo" }, allowlist).status, 403);
  assert.equal(validateTask({ ...valid, branch: "../secret" }, allowlist).status, 400);
  assert.equal(validateTask({ ...valid, mode: "commit" }, allowlist).status, 400);
  assert.equal(validateTask({ ...valid, objective: " " }, allowlist).status, 400);
});

test("accepts debug mode alongside inspect", () => {
  const allowlist = allowedRepositories("cornerstonemarketingus/atlas");
  const result = validateTask({ ...valid, mode: "debug" }, allowlist);
  assert.equal("error" in result, false);
  assert.equal(result.task.mode, "debug");
});

test("accepts coder mode alongside inspect and debug", () => {
  const allowlist = allowedRepositories("cornerstonemarketingus/atlas");
  const result = validateTask(validCoder, allowlist);
  assert.equal("error" in result, false);
  assert.equal(result.task.mode, "coder");
});

test("routes coder tasks to a separate, elevated-permission workflow", () => {
  assert.equal(workflowForMode("inspect"), "atlas-runner.yml");
  assert.equal(workflowForMode("debug"), "atlas-runner.yml");
  assert.equal(workflowForMode("coder"), "atlas-coder.yml");
  assert.equal(workflowForMode("inspect", { defaultWorkflow: "custom-runner.yml" }), "custom-runner.yml");
  assert.equal(workflowForMode("coder", { coderWorkflow: "custom-coder.yml" }), "custom-coder.yml");
  assert.equal(workflowForMode("coder", { defaultWorkflow: "custom-runner.yml" }), "atlas-coder.yml");
});

test("builds a GitHub workflow dispatch without putting the token in its URL or body", () => {
  const task = validateTask(valid, allowedRepositories()).task;
  const request = githubDispatchRequest({ token: "super-secret", workflow: "atlas-runner.yml", task, taskId: "task-123" });
  assert.equal(request.url, "https://api.github.com/repos/cornerstonemarketingus/atlas/actions/workflows/atlas-runner.yml/dispatches");
  assert.equal(request.init.headers.authorization, "Bearer super-secret");
  assert.doesNotMatch(request.url + request.init.body, /super-secret/);
  assert.deepEqual(JSON.parse(request.init.body), { ref: "main", inputs: { repository: "cornerstonemarketingus/atlas", branch: "main", mode: "inspect", objective: "Map the API.", task_id: "task-123" } });
  assert.throws(() => githubDispatchRequest({ token: "super-secret", workflowRef: "feature/unsafe", task, taskId: "task-123" }));
});

test("includes merge_policy only for coder-mode dispatches", () => {
  const coderTask = validateTask(validCoder, allowedRepositories()).task;
  const coderRequest = githubDispatchRequest({ token: "t", workflow: "atlas-coder.yml", task: coderTask, taskId: "task-123", mergePolicy: "ci-gated" });
  assert.equal(JSON.parse(coderRequest.init.body).inputs.merge_policy, "ci-gated");

  const inspectTask = validateTask(valid, allowedRepositories()).task;
  const inspectRequest = githubDispatchRequest({ token: "t", workflow: "atlas-runner.yml", task: inspectTask, taskId: "task-123", mergePolicy: "ci-gated" });
  assert.equal("merge_policy" in JSON.parse(inspectRequest.init.body).inputs, false);
});

test("dispatch helper accepts an injected fetch implementation", async () => {
  const task = validateTask(valid, allowedRepositories()).task;
  let called = false;
  const response = await dispatchGitHub({ token: "secret", task, taskId: "id" }, async (_url, init) => {
    called = true;
    assert.ok(init.signal);
    return new Response(null, { status: 204 });
  });
  assert.equal(called, true);
  assert.equal(response.status, 204);
});

test("sends a valid correlation_id to both Atlas workflows, and never a malformed one", () => {
  const correlationId = `cor_${"9e".repeat(16)}`;
  const inspectTask = validateTask(valid, allowedRepositories()).task;
  const coderTask = validateTask(validCoder, allowedRepositories()).task;
  const inspect = JSON.parse(githubDispatchRequest({ token: "t", workflow: "atlas-runner.yml", task: inspectTask, taskId: "task-123", correlationId }).init.body);
  assert.equal(inspect.inputs.correlation_id, correlationId);
  const coder = JSON.parse(githubDispatchRequest({ token: "t", workflow: "atlas-coder.yml", task: coderTask, taskId: "task-123", correlationId }).init.body);
  assert.equal(coder.inputs.correlation_id, correlationId);
  for (const bad of ["cor_short", `${correlationId}\n`, 7]) {
    const body = JSON.parse(githubDispatchRequest({ token: "t", workflow: "atlas-runner.yml", task: inspectTask, taskId: "task-123", correlationId: bad }).init.body);
    assert.equal("correlation_id" in body.inputs, false);
  }
  // A custom workflow override may not declare the input; GitHub would reject it.
  const custom = JSON.parse(githubDispatchRequest({ token: "t", workflow: "custom-runner.yml", task: inspectTask, taskId: "task-123", correlationId }).init.body);
  assert.equal("correlation_id" in custom.inputs, false);
});

test("both Atlas workflows declare correlation_id as optional and pass it only through env", async () => {
  const fs = await import("node:fs");
  for (const name of ["atlas-runner.yml", "atlas-coder.yml"]) {
    const text = fs.readFileSync(new URL(`../../../.github/workflows/${name}`, import.meta.url), "utf8");
    assert.match(text, /\n {6}correlation_id:\n(?: {8}#.*\n)* {8}description: .*\n {8}required: false\n {8}default: ""\n {8}type: string\n/, name);
    for (const line of text.split("\n").filter((entry) => entry.includes("correlation_id }}"))) {
      assert.match(line, /^\s+ATLAS_CORRELATION_ID: \$\{\{ (?:github\.event\.)?inputs\.correlation_id \}\}$/, `${name}: ${line}`);
    }
  }
});

test("a coding task needs something concrete to change; read-only modes stay open-ended", async () => {
  const { assessCoderObjective } = await import("../app/api/tasks/dispatch.mjs");
  const allowlist = allowedRepositories("cornerstonemarketingus/atlas");
  const coder = (objective) => validateTask({ ...valid, mode: "coder", objective }, allowlist);
  // The objective that exhausted a coder run's turn budget (RECOVERY.md §1).
  const vague = coder("hi can u debug yourself? formy atlas repo can u make direct changes");
  assert.equal(vague.status, 422);
  assert.equal(vague.needsClarification, true);
  assert.match(vague.error, /concrete change/u);
  assert.equal(coder("fix it").status, 422);
  assert.equal(coder("Can you improve things?").status, 422);
  for (const objective of [
    "Fix the login bug in my project. Read the code first, run the tests, and open a pull request.",
    "Create docs/ATLAS-SMOKE-CHECK.md containing exactly one line: Atlas coding smoke check.",
    "Make the navbar sticky on scroll",
    "The checkout page crashes when the cart is empty, please fix",
    "Refactor `parseRoutes` to reject duplicate models",
  ]) assert.ok(assessCoderObjective(objective).ok, objective);
  assert.ok(!("error" in validateTask({ ...valid, mode: "inspect", objective: "hi can u look around?" }, allowlist)));
});

test("coder tasks default to CI-gated autopilot, and a bad setting never widens the policy", async () => {
  const { defaultMergePolicy } = await import("../app/api/tasks/dispatch.mjs");
  assert.equal(defaultMergePolicy(undefined), "ci-gated");
  assert.equal(defaultMergePolicy(""), "ci-gated");
  assert.equal(defaultMergePolicy("manual"), "manual");
  assert.equal(defaultMergePolicy(" CI-Gated "), "ci-gated");
  assert.equal(defaultMergePolicy("none"), "none");
  assert.equal(defaultMergePolicy("yolo"), "manual");
});
