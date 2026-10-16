import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { classifyIntent } from "../app/chat/intent.mjs";
import { userWantsPublic } from "../app/api/chat/project-tools.mjs";
import { migratedDatabase } from "./helpers/d1-sqlite.mjs";
import { getConversation, resolveTenant } from "../db/tenancy.mjs";
import { recoverableProjectCreator, reserveProjectReceipt, createProjectConversation } from "../app/api/genesis/receipts.mjs";
import { isDeploymentOwner } from "../app/api/tasks/self-protection.mjs";

async function route(path, dependencies) {
  const source = await readFile(new URL(path, import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    transformers: { before: [() => (root) => ts.factory.updateSourceFile(root, root.statements.filter((node) => !ts.isImportDeclaration(node)))] },
  }).outputText.replaceAll("export async function", "async function").replace(/export \{\};?/gu, "");
  return new Function(...Object.keys(dependencies), `${compiled}; return { POST };`)(...Object.values(dependencies));
}

test("real hosted project POST denies unauthenticated and ordinary tenants before the deployment-owned node", async () => {
  for (const [account, status] of [[null, 401], [{ userId: "github:customer", dbUserId: 8 }, 403], [{ userId: "operator", dbUserId: null }, 202]]) {
    let called = false;
    const { POST } = await route("../app/api/genesis/operations/route.ts", { authenticatedAccount: async () => account, isDeploymentOwner,
      recoverableProjectCreator, getD1: () => ({}), resolveTenantContext: async () => ({ tenantId: 1, principal: "operator" }), tenantScope: value => value, reserveProjectReceipt: async () => {},
      genesisBridge: () => ({ create: async (input) => { called = true; assert.equal(input.name, "service"); assert.equal(input.conversationId, undefined); return { status: "building", operationId: "project_operation_123" }; } }),
    });
    const response = await POST(new Request("https://atlas.test/api/genesis/operations", { method: "POST", body: JSON.stringify({ name: "service", conversationId: "thread" }) }));
    assert.equal(response.status, status); assert.equal(called, status === 202);
  }
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
    genesisBridge:()=>({create:async input=>{
      const saved=await getConversation(d1,scope,conversationId);
      assert.equal(saved.events.length,1); assert.equal(input.conversationId,undefined);
      return {status:"building",operationId};
    }}),
  });
  const response=await POST(new Request("https://atlas.test/api/genesis/operations",{method:"POST",body:JSON.stringify({requestId:operationId,name:"service"})}));
  assert.equal(response.status,202); assert.equal((await response.json()).conversationId,conversationId);
});
