import { randomUUID } from "node:crypto";
import { getD1 } from "../../../../db";
import { resolveTenantContext, tenantScope } from "../../auth/tenant-context.mjs";
import { createProjectConversation, recoverableProjectCreator, reserveProjectReceipt } from "../receipts.mjs";
import { authenticatedAccount } from "../../tasks/operator-auth.mjs";
import { isDeploymentOwner } from "../../tasks/self-protection.mjs";
import { genesisBridge } from "../bridge.mjs";

// This node belongs to the deployment owner, never to an arbitrary signed-in tenant.
export async function POST(request: Request) {
  const account = await authenticatedAccount(request);
  if (!account) return Response.json({ message: "Sign in is required." }, { status: 401 });
  if (!isDeploymentOwner(account)) return Response.json({ message: "Deployment owner access is required for this Genesis node." }, { status: 403 });
  let input;
  try { input = await request.json(); } catch { return Response.json({ message: "Invalid JSON." }, { status: 400 }); }
  const conversationId = input?.conversationId ?? randomUUID();
  const create = recoverableProjectCreator({
    create: genesisBridge(process.env, { owner: true }).create,
    reserve: async (id: string) => {
      const d1 = getD1();
      const tenant = await resolveTenantContext(request, account, d1);
      const scope = tenant ? tenantScope(tenant) : null;
      if (!input?.conversationId) await createProjectConversation(d1, scope, conversationId);
      return reserveProjectReceipt(d1, scope, conversationId, id);
    },
  });
  const projectInput = { ...input };
  delete projectInput.conversationId;
  const result = await create(projectInput);
  return Response.json({ ...result, conversationId }, { status: result.status === "unavailable" ? 503 : result.status === "failed" ? 400 : 202, headers: { "cache-control": "no-store" } });
}

export async function GET(request: Request) {
  const account = await authenticatedAccount(request);
  if (!account) return Response.json({ message: "Sign in is required." }, { status: 401 });
  if (!isDeploymentOwner(account)) return Response.json({ message: "Deployment owner access is required for this Genesis node." }, { status: 403 });
  const bridge = genesisBridge(process.env, { owner: true });
  const id = new URL(request.url).searchParams.get("id");
  return Response.json(id ? await bridge.status(id) : await bridge.capabilities(), { headers: { "cache-control": "no-store" } });
}
