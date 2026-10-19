import assert from "node:assert/strict";
import test from "node:test";
import { describeProject } from "../app/chat/project-state.mjs";
import { genesisBridge, UNAVAILABLE_NEXT_STEPS } from "../app/api/genesis/bridge.mjs";
import { classifyIntent } from "../app/chat/intent.mjs";

test("an unavailable creation is never shown as planning, with an invented operation or deployment", () => {
  const view = describeProject({ status: "unavailable", reason: "execution_node_not_configured", nextStep: UNAVAILABLE_NEXT_STEPS.execution_node_not_configured, message: "New project creation unavailable." });
  assert.equal(view.stage, "unavailable");
  assert.deepEqual(view.facts, []);
  assert.match(view.nextStep, /ATLAS_GENESIS_URL/u);
  assert.equal(view.polling, false);
});

test("unavailable, planning, executing, blocked, interrupted, failed and completed are distinct stages", () => {
  const stage = (value) => describeProject(value).stage;
  assert.equal(stage({ status: "unavailable" }), "unavailable");
  assert.equal(stage({ status: "building", projectState: "requirements", operationId: "op" }), "planning");
  assert.equal(stage({ status: "building", projectState: "verifying", operationId: "op" }), "executing");
  assert.equal(stage({ status: "publishing", projectState: "ready" }), "executing");
  assert.equal(stage({ status: "awaiting-approval" }), "awaiting-approval");
  assert.equal(stage({ status: "blocked" }), "blocked");
  assert.equal(stage({ status: "interrupted" }), "interrupted");
  assert.equal(stage({ status: "failed", message: "Publishing could not be confirmed." }), "failed");
  assert.equal(stage({ status: "denied" }), "failed");
  assert.equal(stage({ status: "published", repository: { webUrl: "https://github.com/a/b" } }), "completed");
  assert.equal(stage({}), "unknown");
  assert.equal(stage({ status: "something-new" }), "unknown");
});

test("only live stages poll, and a failure surfaces its message", () => {
  for (const status of ["unavailable", "failed", "blocked", "interrupted", "published", "denied"]) assert.equal(describeProject({ status }).polling, false, status);
  for (const status of ["building", "publishing", "awaiting-approval"]) assert.equal(describeProject({ status, projectState: "building" }).polling, true, status);
  assert.match(describeProject({ status: "failed", message: "Publishing did not complete." }).detail, /did not complete/u);
});

test("the bridge names what is missing and never invents an operation receipt", async () => {
  const environment = { ATLAS_GENESIS_URL: "https://node.example", ATLAS_GENESIS_TOKEN: "node-secret-token" };
  const make = (env, options) => genesisBridge(env, { owner: true, ...options });
  assert.equal((await make({}).create({ name: "x", requestId: "request-0123456789ab" })).reason, "execution_node_not_configured");
  assert.equal((await genesisBridge(environment, { owner: false }).create({ requestId: "request-0123456789ab" })).reason, "owner_required");
  assert.equal((await make({ ...environment, ATLAS_GENESIS_URL: "http://node.example" }).create({})).reason, "invalid_execution_node");
  const rejected = await make(environment, { fetchImpl: async () => new Response("{}", { status: 401 }) }).create({ requestId: "request-0123456789ab" });
  assert.equal(rejected.reason, "node_rejected_token");
  assert.equal("operationId" in rejected, false, "an unavailable request has no receipt");
  const unreachable = await make(environment, { fetchImpl: async () => { throw new Error("connect ECONNREFUSED node-secret-token"); } }).create({ requestId: "request-0123456789ab" });
  assert.equal(unreachable.reason, "node_unreachable");
  assert.doesNotMatch(JSON.stringify(unreachable), /node-secret-token|node\.example/u);
  const accepted = await make(environment, { fetchImpl: async () => Response.json({ status: "building" }) }).create({ requestId: "request-0123456789ab" });
  assert.equal(accepted.operationId, "request-0123456789ab");
  for (const reason of Object.keys(UNAVAILABLE_NEXT_STEPS)) assert.doesNotMatch(UNAVAILABLE_NEXT_STEPS[reason], /bearer\s|password|https?:\/\//iu);
});

test("website and web-app creation requests start a new project instead of a chat answer", () => {
  const kind = (message, hasProject = false) => classifyIntent(message, { hasProject }).kind;
  const hahn = "Build a responsive website for Team Hahn Construction in Eagan, Minnesota, specializing in wood framing, windows, doors, and housewrap.";
  assert.equal(kind(hahn), "new_project_task");
  assert.equal(kind(hahn, true), "new_project_task");
  assert.equal(kind("Can you build me a modern web app for tracking leads?"), "new_project_task");
  assert.equal(kind("Build a landing page for my bakery"), "new_project_task");
  // Existing-project work, questions and small edits stay what they were.
  assert.equal(kind("Build a website for my project", true), "project_task");
  assert.equal(kind("Make the website faster", true), "project_task");
  assert.equal(kind("add a landing page to my repo", true), "project_task");
  assert.equal(kind("How do I build a website?"), "chat");
  assert.equal(kind("Fix the bug in the header", true), "project_task");
});
