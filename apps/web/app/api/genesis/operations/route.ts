import { getD1 } from "../../../../db";
import { hostedSiteStore } from "../../../../db/hosted-sites.mjs";
import { resolveTenantContext, tenantScope } from "../../auth/tenant-context.mjs";
import { authenticatedAccount } from "../../tasks/operator-auth.mjs";
import { isDeploymentOwner } from "../../tasks/self-protection.mjs";
import { genesisBridge } from "../bridge.mjs";
import { projectBackend } from "../project-backend.mjs";

/** The caller's workspace for hosted creation, or null when it cannot be resolved (the node path still works for the owner). */
async function hostedFor(request: Request, account: NonNullable<Awaited<ReturnType<typeof authenticatedAccount>>>) {
  try {
    const tenant = await resolveTenantContext(request, account, getD1());
    return tenant ? { store: hostedSiteStore(getD1()), scope: tenantScope(tenant) } : null;
  } catch { return null; }
}

// The Genesis node belongs to the deployment owner, never to an arbitrary signed-in tenant.
// Any signed-in workspace member may build a website with the hosted builder, which runs no generated code.
export async function POST(request: Request) {
  const account = await authenticatedAccount(request);
  if (!account) return Response.json({ message: "Sign in is required." }, { status: 401 });
  let input;
  try { input = await request.json(); } catch { return Response.json({ message: "Invalid JSON." }, { status: 400 }); }
  const bridge = genesisBridge(process.env, { owner: isDeploymentOwner(account) });
  const backend = projectBackend({ bridge, hosted: await hostedFor(request, account), userMessage: typeof input?.description === "string" ? input.description : "" });
  const result = await backend.create(input);
  const status = result.status === "unavailable" ? 503 : result.status === "failed" ? 400 : result.status === "ready" ? 201 : 202;
  return Response.json(result, { status, headers: { "cache-control": "no-store" } });
}

export async function GET(request: Request) {
  const account = await authenticatedAccount(request);
  if (!account) return Response.json({ message: "Sign in is required." }, { status: 401 });
  const id = new URL(request.url).searchParams.get("id");
  const owner = isDeploymentOwner(account);
  // A hosted website is read through its own workspace; node operations and capabilities stay owner-only.
  if (id?.startsWith("gen_")) {
    const backend = projectBackend({ bridge: genesisBridge(process.env, { owner }), hosted: await hostedFor(request, account) });
    return Response.json(await backend.status(id), { headers: { "cache-control": "no-store" } });
  }
  if (!owner) return Response.json({ message: "Deployment owner access is required for this Genesis node." }, { status: 403 });
  const bridge = genesisBridge(process.env, { owner: true });
  return Response.json(id ? await bridge.status(id) : await bridge.capabilities(), { headers: { "cache-control": "no-store" } });
}
