import assert from "node:assert/strict";
import test from "node:test";
import { authenticatedAccount, authenticatedUserId } from "../app/api/tasks/operator-auth.mjs";
import { signSession, sessionCookieHeader } from "../app/api/auth/session.mjs";

function request(headers) {
  return new Request("http://localhost/api/tasks", { headers });
}

test("prefers the platform-injected header when present", async () => {
  const id = await authenticatedUserId(request({ "oai-authenticated-user-id": "platform-user" }), { ATLAS_OPERATOR_TOKEN: "secret" });
  assert.equal(id, "platform-user");
});

test("accepts a matching bearer token when no platform header is set", async () => {
  const id = await authenticatedUserId(request({ authorization: "Bearer secret" }), { ATLAS_OPERATOR_TOKEN: "secret" });
  assert.equal(id, "operator");
});

test("rejects a missing, mismatched, or malformed bearer token", async () => {
  const environment = { ATLAS_OPERATOR_TOKEN: "secret" };
  assert.equal(await authenticatedUserId(request({}), environment), null);
  assert.equal(await authenticatedUserId(request({ authorization: "Bearer wrong" }), environment), null);
  assert.equal(await authenticatedUserId(request({ authorization: "secret" }), environment), null);
});

test("rejects every request when neither an operator token nor a session secret is configured", async () => {
  const id = await authenticatedUserId(request({ authorization: "Bearer secret" }), {});
  assert.equal(id, null);
});

test("platform and operator paths carry no billable dbUserId", async () => {
  const environment = { ATLAS_OPERATOR_TOKEN: "secret" };
  const platform = await authenticatedAccount(request({ "oai-authenticated-user-id": "platform-user" }), environment);
  assert.deepEqual(platform, { userId: "platform-user", dbUserId: null });
  const operator = await authenticatedAccount(request({ authorization: "Bearer secret" }), environment);
  assert.deepEqual(operator, { userId: "operator", dbUserId: null });
});

test("accepts a valid signed session cookie and resolves its dbUserId", async () => {
  const environment = { ATLAS_SESSION_SECRET: "session-secret" };
  const token = await signSession({ uid: 42, gh: "octocat" }, environment.ATLAS_SESSION_SECRET);
  const account = await authenticatedAccount(request({ cookie: sessionCookieHeader(token).split(";")[0] }), environment);
  assert.deepEqual(account, { userId: "github:octocat", dbUserId: 42 });
});

test("rejects a session cookie signed with the wrong secret", async () => {
  const token = await signSession({ uid: 42, gh: "octocat" }, "wrong-secret");
  const account = await authenticatedAccount(request({ cookie: sessionCookieHeader(token).split(";")[0] }), { ATLAS_SESSION_SECRET: "session-secret" });
  assert.equal(account, null);
});

test("rejects a session cookie when no session secret is configured", async () => {
  const token = await signSession({ uid: 42, gh: "octocat" }, "session-secret");
  const account = await authenticatedAccount(request({ cookie: sessionCookieHeader(token).split(";")[0] }), {});
  assert.equal(account, null);
});
