import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPair, SignJWT } from "jose";
import { RUNNER_AUDIENCE, verifyRunnerIdentity, resultBelongsToTask, validateRunnerResult, correlationMatchesTask } from "../app/api/tasks/runner-result.mjs";
import { statusLine } from "../app/build/task-presentation.mjs";

const task = { taskId: "2cb4e27b-536c-476b-93a2-8db3f3a3ba72", repository: "cornerstonemarketingus/atlas", mode: "coder", executionProvider: "managed", githubRunId: null };
const identity = { repository: task.repository, workflow_ref: `${task.repository}/.github/workflows/atlas-coder.yml@refs/heads/main`, run_id: "123", run_attempt: "1", event_name: "workflow_dispatch", ref: "refs/heads/main" };
const run = { id: 123, run_attempt: 1, event: "workflow_dispatch", head_branch: "main", path: ".github/workflows/atlas-coder.yml", display_title: `Atlas Coder · task ${task.taskId}` };

test("signed identity rejects expired, wrong audience, forged, and non-main tokens", async () => {
  const pair = await generateKeyPair("RS256");
  const other = await generateKeyPair("RS256");
  const sign = (claims = identity, audience = RUNNER_AUDIENCE, expires = "5m", key = pair.privateKey) => new SignJWT(claims).setProtectedHeader({ alg: "RS256" }).setIssuer("https://token.actions.githubusercontent.com").setAudience(audience).setIssuedAt().setExpirationTime(expires).sign(key);
  assert.equal((await verifyRunnerIdentity(await sign(), pair.publicKey)).run_id, "123");
  await assert.rejects(verifyRunnerIdentity(await sign(identity, "elsewhere"), pair.publicKey));
  await assert.rejects(verifyRunnerIdentity(await sign(identity, RUNNER_AUDIENCE, "-1s"), pair.publicKey));
  await assert.rejects(verifyRunnerIdentity(await sign(identity, RUNNER_AUDIENCE, "5m", other.privateKey), pair.publicKey));
  await assert.rejects(verifyRunnerIdentity(await sign({ ...identity, ref: "refs/heads/feature" }), pair.publicKey));
});

test("result is bound to the exact task, workflow, repo, run and attempt", () => {
  assert.equal(resultBelongsToTask(identity, task, run), true);
  for (const changed of [{ repository: "other/repo" }, { workflow_ref: identity.workflow_ref.replace("atlas-coder", "ci") }, { run_id: "124" }, { run_attempt: "2" }]) assert.equal(resultBelongsToTask({ ...identity, ...changed }, task, run), false);
  assert.equal(resultBelongsToTask(identity, { ...task, githubRunId: 777 }, run), false);
  assert.equal(resultBelongsToTask(identity, task, { ...run, display_title: "Atlas Coder · task somebody-else" }), false);
  assert.equal(resultBelongsToTask(identity, task, { ...run, event: "pull_request" }), false);
});

test("payload is bounded and caller cannot select tenant", () => {
  assert.deepEqual(validateRunnerResult({ taskId: task.taskId, summary: "Tests failed", requestedBy: "another-user" }), { taskId: task.taskId, summary: "Tests failed" });
  for (const summary of ["", "x".repeat(16001), null]) assert.throws(() => validateRunnerResult({ taskId: task.taskId, summary }));
});

test("a green workflow without a PR never asserts successful changes or validation", () => {
  const text = statusLine({ mode: "coder", status: "succeeded" });
  assert.match(text, /no pull request/);
  assert.doesNotMatch(text, /nothing.*changed|passed validation|change completed/i);
  assert.match(statusLine({ mode: "coder", status: "succeeded", pullRequest: { url: "https://github.com/a/b/pull/1" } }), /validation evidence/);
  assert.match(statusLine({ status: "failed" }), /failing step/);
});

test("optional correlation id is validated and a mismatch with the stored task is refused", () => {
  const correlationId = `cor_${"5a".repeat(16)}`;
  const other = `cor_${"b7".repeat(16)}`;
  // Backward compatible: a result without a correlation id is still accepted.
  const legacy = validateRunnerResult({ taskId: task.taskId, summary: "done" });
  assert.deepEqual(legacy, { taskId: task.taskId, summary: "done" });
  assert.equal(correlationMatchesTask(legacy, { ...task, correlationId }), true);
  assert.deepEqual(validateRunnerResult({ taskId: task.taskId, summary: "done", correlationId: null }), { taskId: task.taskId, summary: "done" });
  const tagged = validateRunnerResult({ taskId: task.taskId, summary: "done", correlationId });
  assert.equal(tagged.correlationId, correlationId);
  assert.equal(correlationMatchesTask(tagged, { ...task, correlationId }), true);
  // Task rows from before migration 0013 carry no id; the result is accepted.
  assert.equal(correlationMatchesTask(tagged, { ...task, correlationId: null }), true);
  assert.equal(correlationMatchesTask(tagged, task), true);
  assert.equal(correlationMatchesTask(tagged, { ...task, correlationId: other }), false);
  for (const bad of ["cor_short", `${correlationId}x`, correlationId.toUpperCase(), 12, ""]) {
    assert.throws(() => validateRunnerResult({ taskId: task.taskId, summary: "done", correlationId: bad }), undefined, String(bad));
  }
});
