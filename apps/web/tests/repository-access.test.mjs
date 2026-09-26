import assert from "node:assert/strict";
import test from "node:test";

import { repositoryAccessDecision, requiredPermission } from "../app/api/tasks/repository-access.mjs";

const answer = (status, body = {}) => async (url) => { answer.calls.push(url); return new Response(JSON.stringify(body), { status }); };
answer.calls = [];
const task = (mode) => ({ repository: "acme/app", branch: "main", mode, objective: "x" });
const alice = { userId: "github:alice", dbUserId: 3 };

test("coding needs write access, reviews need read access (SEC-1)", async () => {
  assert.equal(requiredPermission("coder"), "write");
  assert.equal(requiredPermission("inspect"), "read");
  assert.deepEqual(await repositoryAccessDecision(alice, task("coder"), { token: "t", fetcher: answer(200, { permission: "write", role_name: "write" }) }), { allowed: true });
  assert.match(answer.calls.at(-1), /repos\/acme\/app\/collaborators\/alice\/permission$/u);
  const reader = await repositoryAccessDecision(alice, task("coder"), { token: "t", fetcher: answer(200, { permission: "read", role_name: "read" }) });
  assert.equal(reader.allowed, false);
  assert.equal(reader.status, 403);
  assert.match(reader.message, /needs write access.*has read access/u);
  assert.deepEqual(await repositoryAccessDecision(alice, task("inspect"), { token: "t", fetcher: answer(200, { permission: "read", role_name: "triage" }) }), { allowed: true });
  assert.equal((await repositoryAccessDecision(alice, task("coder"), { token: "t", fetcher: answer(200, { permission: "admin", role_name: "maintain" }) })).allowed, true);
});

test("strangers, unverifiable principals and unanswerable checks are refused", async () => {
  const stranger = await repositoryAccessDecision(alice, task("inspect"), { token: "t", fetcher: answer(404) });
  assert.equal(stranger.code, "REPOSITORY_ACCESS_DENIED");
  assert.equal((await repositoryAccessDecision({ userId: "platform-bob", dbUserId: null }, task("inspect"), { token: "t", fetcher: answer(200, { permission: "admin" }) })).code, "REPOSITORY_ACCESS_UNVERIFIABLE");
  const expired = await repositoryAccessDecision(alice, task("inspect"), { token: "t", fetcher: answer(401) });
  assert.equal(expired.status, 502);
  assert.equal(expired.code, "GITHUB_TOKEN_INVALID");
  assert.equal((await repositoryAccessDecision(alice, task("inspect"), { token: "t", fetcher: async () => { throw new Error("offline"); } })).allowed, false);
});

test("the deployment owner is not looked up", async () => {
  let called = false;
  assert.deepEqual(await repositoryAccessDecision({ userId: "operator", dbUserId: null }, task("coder"), { token: "t", fetcher: async () => { called = true; return new Response("{}"); } }), { allowed: true });
  assert.equal(called, false);
});
