import assert from "node:assert/strict";
import test from "node:test";
import { classifyIntent } from "../app/chat/intent.mjs";
import { atlasSystemPrompt } from "../app/api/chat/atlas-knowledge.mjs";
import { createProjectTools, userWantsPublic } from "../app/api/chat/project-tools.mjs";
import { genesisBridge } from "../app/api/genesis/bridge.mjs";

test("new project intent is independent of the selected repository", () => {
  for (const text of ["create a repo and idc, ideally an online service business that can run autonomously", "Start a new project for estimates", "Build this as its own app", "Make a new GitHub repository", "Create a new business", "Build me a separate app for roofing estimates", "Can you create a new repo for a SaaS?"]) {
    for (const hasProject of [true, false]) assert.equal(classifyIntent(text, { hasProject }).kind, "new_project_task", text);
  }
  assert.equal(classifyIntent("Fix Atlas login", { hasProject: true }).kind, "project_task");
  assert.equal(classifyIntent("How do I create a new repo?").kind, "chat");
});

test("structured registry defaults private, emits receipt and never exposes credentials", async () => {
  let input;
  const tools = createProjectTools({ requestId: "test_operation_123", userMessage: "Create a new repo", create: async (value) => { input = value; return { operationId: value.requestId, status: "building" }; }, status: async () => ({ status: "published", repository: { webUrl: "https://github.com/me/app" } }) });
  assert.deepEqual(tools.definitions.map((t) => t.function.name), ["workspace_create_project", "workspace_project_status"]);
  const call = (args) => ({ function: { arguments: JSON.stringify(args) } });
  const events = [];
  const result = await tools.handlers.workspace_create_project(call({ name: "app", description: "A service" }), { emit: (...args) => events.push(args) });
  assert.equal(input.visibility, "private"); assert.equal(input.host, "github"); assert.equal(events[0][0], "project");
  assert.equal(JSON.parse(result.content).status, "building");
  assert.equal((await tools.handlers.workspace_create_project(call({ name: "app", description: "A service", visibility: "public" }))).ok, false);
  assert.equal(userWantsPublic("private, not public"), false);
  assert.equal(userWantsPublic("Create a public repo"), true);
  assert.equal(userWantsPublic("Create a new project for public-data aggregation"), false);
  assert.equal(userWantsPublic("Create a repo and make it public"), true);
  assert.match((await tools.handlers.workspace_project_status(call({ operationId: "test_operation_123" }))).content, /https:\/\/github.com/);
});

test("bridge is owner-only, HTTPS-only, server configured and reports real unavailability", async () => {
  let calls = 0;
  const environment = { ATLAS_GENESIS_URL: "https://genesis.test", ATLAS_GENESIS_TOKEN: "server-secret" };
  const fetchImpl = async (url, init) => { calls++; assert.equal(init.headers.authorization, "Bearer server-secret"); assert.equal(init.redirect, "manual"); return Response.json({ github: { connected: true, canCreateRepositories: true }, publish: { policy: "ask" } }); };
  assert.equal((await genesisBridge(environment, { fetchImpl }).capabilities()).github.reason, "owner_required");
  assert.equal(calls, 0);
  assert.equal((await genesisBridge({ ...environment, ATLAS_GENESIS_URL: "http://localhost" }, { owner: true, fetchImpl }).capabilities()).github.reason, "invalid_execution_node");
  const state = await genesisBridge(environment, { owner: true, fetchImpl }).capabilities();
  assert.equal(state.github.canCreateRepositories, true);
  const prompt = atlasSystemPrompt({ projectCapabilities: state });
  assert.match(prompt, /workspace_create_project/); assert.match(prompt, /"policy":"ask"/);
  assert.doesNotMatch(prompt, /server-secret|offer to build it inside/);
  const unreachable = await genesisBridge(environment, { owner: true, fetchImpl: async () => { throw new Error("server-secret"); } }).create({});
  assert.equal(unreachable.status, "unavailable"); assert.doesNotMatch(JSON.stringify(unreachable), /server-secret/);
});

test("a missing operation receipt is unconfirmed and reading it never creates a project", async () => {
  let calls = 0;
  const bridge = genesisBridge({ATLAS_GENESIS_URL:"https://genesis.test",ATLAS_GENESIS_TOKEN:"server-secret"}, {owner:true, fetchImpl: async (url, init) => {calls++; assert.equal(init.method,"GET"); assert.match(url.pathname,/operations/); return new Response("missing",{status:404});}});
  assert.equal((await bridge.status("operation_123456789")).status,"not-found");
  assert.equal(calls,1);
});
