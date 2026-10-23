import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { randomUUID } from "node:crypto";
import ts from "typescript";
import { classifyIntent } from "../app/chat/intent.mjs";
import { userWantsPublic } from "../app/api/chat/project-tools.mjs";
import { migratedDatabase } from "./helpers/d1-sqlite.mjs";
import { getConversation, resolveTenant } from "../db/tenancy.mjs";
import { recoverableProjectCreator, reserveProjectReceipt, createProjectConversation } from "../app/api/genesis/receipts.mjs";
import { isDeploymentOwner } from "../app/api/tasks/self-protection.mjs";
import { projectBackend } from "../app/api/genesis/project-backend.mjs";

async function route(path, dependencies) {
  const source = await readFile(new URL(path, import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    transformers: { before: [() => (root) => ts.factory.updateSourceFile(root, root.statements.filter((node) => !ts.isImportDeclaration(node)))] },
  }).outputText.replaceAll("export async function", "async function").replace(/export \{\};?/gu, "");
  return new Function(...Object.keys(dependencies), `${compiled}; return { POST: typeof POST === "function" ? POST : undefined, GET: typeof GET === "function" ? GET : undefined };`)(...Object.values(dependencies));
}

test("real project POST: node for the owner, hosted builder for workspace members, 401 for strangers", async () => {
  const { d1, store } = (await import("./helpers/hosted.mjs")).hostedHarness();
  const calls = [];
  const dependencies = { isDeploymentOwner, getD1: () => d1, hostedSiteStore: () => store, tenantScope: (tenant) => tenant, projectBackend,
    randomUUID, reserveProjectReceipt, createProjectConversation,
    resolveTenantContext: async (_request, account) => ({ tenantId: 1, principal: account.userId }),
    genesisBridge: (_environment, { owner }) => ({ available: owner, create: async (input) => { calls.push(input.name); return owner ? { status: "building", operationId: "project_operation_123" } : { status: "unavailable", reason: "owner_required" }; }, status: async () => ({ status: "not-found" }) }),
  };
  const post = async (account, body) => {
    const { POST } = await route("../app/api/genesis/operations/route.ts", { ...dependencies, authenticatedAccount: async () => account });
    return POST(new Request("https://atlas.test/api/genesis/operations", { method: "POST", body: JSON.stringify(body) }));
  };
  assert.equal((await post(null, { name: "service" })).status, 401);
  const website = { requestId: "11111111-aaaa-4bbb-8ccc-dddddddddddd", name: "team-hahn", description: "Build a responsive website for Team Hahn Construction in Eagan, Minnesota, specializing in wood framing, windows, doors, and housewrap." };
  const member = await post({ userId: "github:customer", dbUserId: 8 }, website);
  assert.equal(member.status, 201);
  const built = await member.json();
  assert.equal(built.status, "ready"); assert.equal(built.name, "Team Hahn Construction"); assert.deepEqual(calls, [], "a member never reaches the deployment-owned node");
  const owner = await post({ userId: "operator", dbUserId: null }, { ...website, requestId: "22222222-aaaa-4bbb-8ccc-dddddddddddd" });
  assert.equal(owner.status, 202); assert.deepEqual(calls, ["team-hahn"]);
  // An app a member asks for cannot be built without the node: the reason comes back as a 503, not a substitute.
  const app = await post({ userId: "github:customer", dbUserId: 8 }, { requestId: "33333333-aaaa-4bbb-8ccc-dddddddddddd", name: "svc", description: "Build a REST API for inventory items" });
  assert.equal(app.status, 503);
});

test("real project GET reads a hosted site only through its own workspace and keeps node reads owner-only", async () => {
  const { d1, store } = (await import("./helpers/hosted.mjs")).hostedHarness();
  const base = { isDeploymentOwner, getD1: () => d1, hostedSiteStore: () => store, tenantScope: (tenant) => tenant, projectBackend,
    genesisBridge: () => ({ available: false, capabilities: async () => ({}), status: async () => ({ status: "not-found" }), create: async () => ({}) }) };
  const owner = { userId: "github:customer", dbUserId: 8 };
  const load = async (account, tenantPrincipal = account?.userId) => (await route("../app/api/genesis/operations/route.ts", { ...base, authenticatedAccount: async () => account,
    resolveTenantContext: async () => ({ tenantId: 1, principal: tenantPrincipal }) })).GET;
  const { createHostedSite } = await import("../app/api/genesis/hosted-site.mjs");
  const created = await createHostedSite({ store, scope: { tenantId: 1, principal: owner.userId }, requestId: "44444444-aaaa-4bbb-8ccc-dddddddddddd", userMessage: "Build a website for Acme Roofing in Duluth, Minnesota" });
  const url = (id) => new Request(`https://atlas.test/api/genesis/operations?id=${id}`);
  assert.equal((await (await load(owner))(url(created.operationId))).status, 200);
  assert.equal((await (await (await load(owner))(url(created.operationId))).json()).status, "ready");
  assert.equal((await (await (await load(owner, "github:other"))(url(created.operationId))).json()).status, "not-found", "another member never sees it");
  assert.equal((await (await load(owner))(url("project_operation_123"))).status, 403, "node operations stay owner-only");
  assert.equal((await (await load(null))(url(created.operationId))).status, 401);
});

test("real coder task POST routes new-project intent without consulting or mutating the selected repository", async () => {
  let received;
  const never = () => assert.fail("new projects must not enter selected-repository dispatch");
  const { POST } = await route("../app/api/tasks/route.ts", {
    authenticatedAccount: async () => ({ userId: "operator", dbUserId: null }),
    correlationIdFromRequest: () => "cor_" + "a".repeat(32), CORRELATION_HEADER: "x-atlas-correlation-id",
    classifyIntent, userWantsPublic, getD1: never, validateTask: never,
    createProject: async (request) => { received = await request.json(); return Response.json({ status: "building", operationId: received.requestId }, { status: 202 }); },
  });
  const response = await POST(new Request("https://atlas.test/api/tasks", { method: "POST", body: JSON.stringify({ repository: "cornerstonemarketingus/atlas", branch: "main", mode: "coder", objective: "Create a new repo for a SaaS business" }) }));
  assert.equal(response.status, 202); assert.equal(received.visibility, "private"); assert.equal(received.template, "web-app");
  assert.equal(received.repository, undefined); assert.equal(received.branch, undefined); assert.match(received.name, /^atlas-project-/u);
});

test("direct project POST without a thread persists a recoverable owned conversation before Genesis runs", async t => {
  const {sqlite,d1} = migratedDatabase(); t.after(() => sqlite.close());
  const account = {userId:"operator",dbUserId:null};
  const tenant = await resolveTenant(d1,account);
  const scope = {tenantId:tenant.tenantId,principal:tenant.principal};
  const conversationId="11111111-1111-4111-8111-111111111111";
  const operationId="operation_123456789";
  const {POST} = await route("../app/api/genesis/operations/route.ts", {
    authenticatedAccount:async()=>account,isDeploymentOwner,randomUUID:()=>conversationId,
    getD1:()=>d1,resolveTenantContext:async()=>tenant,tenantScope:()=>scope,
    recoverableProjectCreator,reserveProjectReceipt,createProjectConversation,
    hostedSiteStore:()=>null,projectBackend,
    genesisBridge:()=>({create:async input=>{
      const saved=await getConversation(d1,scope,conversationId);
      assert.equal(saved.events.length,1); assert.equal(input.conversationId,undefined);
      return {status:"building",operationId};
    }}),
  });
  const response=await POST(new Request("https://atlas.test/api/genesis/operations",{method:"POST",body:JSON.stringify({requestId:operationId,name:"service"})}));
  assert.equal(response.status,202); assert.equal((await response.json()).conversationId,conversationId);
});
