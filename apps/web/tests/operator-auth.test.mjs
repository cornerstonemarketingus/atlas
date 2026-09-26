import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { authenticatedAccount, authenticatedUserId, constantTimeEqual } from "../app/api/tasks/operator-auth.mjs";
import { signSession, sessionCookieHeader } from "../app/api/auth/session.mjs";

function request(headers) {
  return new Request("http://localhost/api/tasks", { headers });
}

test("prefers the platform-injected header when present", async () => {
  const id = await authenticatedUserId(request({ "oai-authenticated-user-id": "platform-user" }), { ATLAS_TRUST_PLATFORM_HEADERS: "true", ATLAS_OPERATOR_TOKEN: "secret" });
  assert.equal(id, "platform-user");
});

test("accepts a matching bearer token when no platform header is set", async () => {
  const id = await authenticatedUserId(request({ authorization: "Bearer secret" }), { ATLAS_TRUST_PLATFORM_HEADERS: "true", ATLAS_OPERATOR_TOKEN: "secret" });
  assert.equal(id, "operator");
});

test("rejects a missing, mismatched, or malformed bearer token", async () => {
  const environment = { ATLAS_TRUST_PLATFORM_HEADERS: "true", ATLAS_OPERATOR_TOKEN: "secret" };
  assert.equal(await authenticatedUserId(request({}), environment), null);
  assert.equal(await authenticatedUserId(request({ authorization: "Bearer wrong" }), environment), null);
  assert.equal(await authenticatedUserId(request({ authorization: "secret" }), environment), null);
});

test("rejects every request when neither an operator token nor a session secret is configured", async () => {
  const id = await authenticatedUserId(request({ authorization: "Bearer secret" }), {});
  assert.equal(id, null);
});

test("platform and operator paths carry no billable dbUserId", async () => {
  const environment = { ATLAS_TRUST_PLATFORM_HEADERS: "true", ATLAS_OPERATOR_TOKEN: "secret" };
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

test("accepts an operator session without persisting the operator credential in browser storage", async () => {
  const environment = { ATLAS_SESSION_SECRET: "session-secret" };
  const token = await signSession({ role: "operator" }, environment.ATLAS_SESSION_SECRET);
  const account = await authenticatedAccount(request({ cookie: sessionCookieHeader(token).split(";")[0] }), environment);
  assert.deepEqual(account, { userId: "operator", dbUserId: null });
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

test("public callers cannot forge platform, GitHub, or operator identities", async () => {
  for (const id of ["operator", "github:owner", "platform-user"]) {
    assert.equal(await authenticatedAccount(request({ "oai-authenticated-user-id": id }), { ATLAS_OPERATOR_TOKEN: "secret" }), null);
  }
  for (const id of ["operator", "github:owner"]) {
    assert.equal(await authenticatedAccount(request({ "oai-authenticated-user-id": id }), { ATLAS_TRUST_PLATFORM_HEADERS: "true" }), null);
  }
});

test("the operator token is compared in constant time over SHA-256 digests", async () => {
  assert.equal(await constantTimeEqual("secret", "secret"), true);
  assert.equal(await constantTimeEqual("secret", "secreT"), false);
  assert.equal(await constantTimeEqual("secret", "secret-longer"), false);
  assert.equal(await constantTimeEqual("", "secret"), false);
  assert.equal(await constantTimeEqual(undefined, "secret"), false);
  const source = readFileSync(new URL("../app/api/tasks/operator-auth.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /header === (?!"string")/u, "no plain string equality on the bearer header");
  assert.match(source, /createHash\("sha256"\)/u);
  const route = readFileSync(new URL("../app/api/auth/operator/route.ts", import.meta.url), "utf8");
  assert.match(route, /await constantTimeEqual\(accessCode, expected\)/u);
  assert.doesNotMatch(route, /left\.length !== right\.length/u, "the access-code check no longer leaks length");
});

test("a bearer token that only shares a prefix with the operator token is rejected", async () => {
  const environment = { ATLAS_OPERATOR_TOKEN: "secret-operator-token" };
  assert.equal(await authenticatedUserId(request({ authorization: "Bearer secret-operator-toke" }), environment), null);
  assert.equal(await authenticatedUserId(request({ authorization: "Bearer secret-operator-token-x" }), environment), null);
  assert.equal(await authenticatedUserId(request({ authorization: "bearer secret-operator-token" }), environment), null);
  assert.equal(await authenticatedUserId(request({ authorization: "Bearer secret-operator-token" }), environment), "operator");
});
