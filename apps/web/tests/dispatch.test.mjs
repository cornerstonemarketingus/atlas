import assert from "node:assert/strict";
import test from "node:test";
import { allowedRepositories, dispatchGitHub, githubDispatchRequest, validateTask } from "../app/api/tasks/dispatch.mjs";

const valid = { repository: "Cornerstonemarketingus/atlas", branch: "main", mode: "inspect", objective: " Map the API. " };

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

test("builds a GitHub workflow dispatch without putting the token in its URL or body", () => {
  const task = validateTask(valid, allowedRepositories()).task;
  const request = githubDispatchRequest({ token: "super-secret", workflow: "atlas-runner.yml", task, taskId: "task-123" });
  assert.equal(request.url, "https://api.github.com/repos/cornerstonemarketingus/atlas/actions/workflows/atlas-runner.yml/dispatches");
  assert.equal(request.init.headers.authorization, "Bearer super-secret");
  assert.doesNotMatch(request.url + request.init.body, /super-secret/);
  assert.deepEqual(JSON.parse(request.init.body), { ref: "main", inputs: { repository: "cornerstonemarketingus/atlas", branch: "main", mode: "inspect", objective: "Map the API.", task_id: "task-123" } });
  assert.throws(() => githubDispatchRequest({ token: "super-secret", workflowRef: "feature/unsafe", task, taskId: "task-123" }));
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
