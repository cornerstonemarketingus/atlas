import assert from "node:assert/strict";
import test from "node:test";
import { authenticatedUserId } from "../app/api/tasks/operator-auth.mjs";

function request(headers) {
  return new Request("http://localhost/api/tasks", { headers });
}

test("prefers the platform-injected header when present", () => {
  const id = authenticatedUserId(request({ "oai-authenticated-user-id": "platform-user" }), { ATLAS_OPERATOR_TOKEN: "secret" });
  assert.equal(id, "platform-user");
});

test("accepts a matching bearer token when no platform header is set", () => {
  const id = authenticatedUserId(request({ authorization: "Bearer secret" }), { ATLAS_OPERATOR_TOKEN: "secret" });
  assert.equal(id, "operator");
});

test("rejects a missing, mismatched, or malformed bearer token", () => {
  const environment = { ATLAS_OPERATOR_TOKEN: "secret" };
  assert.equal(authenticatedUserId(request({}), environment), null);
  assert.equal(authenticatedUserId(request({ authorization: "Bearer wrong" }), environment), null);
  assert.equal(authenticatedUserId(request({ authorization: "secret" }), environment), null);
});

test("rejects every request when no operator token is configured", () => {
  const id = authenticatedUserId(request({ authorization: "Bearer secret" }), {});
  assert.equal(id, null);
});
