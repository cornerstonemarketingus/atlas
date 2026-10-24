import assert from "node:assert/strict";
import test from "node:test";
import { customerEvent } from "../app/api/chat/customer-events.mjs";
import { createProjectTools } from "../app/api/chat/project-tools.mjs";

test("a model template guess is corrected only for the person's recognized website request", async () => {
  for (const [userMessage, expected] of [["Build a construction site.", "static-site"], ["Build a website with a REST API", "web-app"], ["Build a website for Acme Plumbing in Denver with a login and database", "web-app"], ["Build a REST API for inventory.", "web-app"]]) {
    let received;
    const tools = createProjectTools({ requestId: "fixture", userMessage, create: async input => { received = input; return { status: "ready" }; }, status: async () => ({ status: "not-found" }) });
    await tools.handlers.workspace_create_project({ function: { arguments: JSON.stringify({ name: "construction", description: "Build a construction website.", template: "web-app" }) } });
    assert.equal(received.template, expected);
    assert.equal(received.visibility, "private");
  }
});

test("completed hosted website retains only a validated preview in customer activity", () => {
  const path = "/preview/gen_11111111-aaaa-4bbb-8ccc-dddddddddddd";
  const result = customerEvent("project", { status: "ready", operationId: "gen_11111111-aaaa-4bbb-8ccc-dddddddddddd", previewUrl: path, message: "PRIVATE_DIAGNOSTIC", credentials: "PRIVATE_DIAGNOSTIC" });
  assert.equal(result.status, "ready");
  assert.equal(result.previewUrl, path);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_DIAGNOSTIC/u);
  for (const previewUrl of ["https://evil.test/", "//evil.test/", "/preview/gen_11111111-aaaa-4bbb-8ccc-dddddddddddd/../secret"]) {
    assert.equal(customerEvent("project", { status: "ready", previewUrl }).previewUrl, undefined);
  }
});

test("unavailable creation never reports progress or repeats internal diagnostics", () => {
  const result = customerEvent("project", { status: "unavailable", reason: "owner_required", message: "PRIVATE_DIAGNOSTIC" });
  assert.equal(result.status, "unavailable");
  assert.match(result.message, /not created|could not start/iu);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_DIAGNOSTIC|status updated|review its progress/u);
});

test("unknown project statuses fall back to building and never carry unvalidated fields", () => {
  const result = customerEvent("project", { status: "PRIVATE_STATUS", operationId: "gen_x", previewUrl: "/preview/gen_x", message: "PRIVATE_DIAGNOSTIC" });
  assert.equal(result.status, "building");
  assert.equal(result.previewUrl, undefined);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE/u);
  assert.equal(customerEvent("project", { status: "ready", operationId: "gen_22222222-aaaa-4bbb-8ccc-dddddddddddd", previewUrl: "/preview/gen_11111111-aaaa-4bbb-8ccc-dddddddddddd" }).previewUrl, undefined);
});
