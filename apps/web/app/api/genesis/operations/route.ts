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
  const result = await genesisBridge(process.env, { owner: true }).create(input);
  return Response.json(result, { status: result.status === "unavailable" ? 503 : result.status === "failed" ? 400 : 202, headers: { "cache-control": "no-store" } });
}

export async function GET(request: Request) {
  const account = await authenticatedAccount(request);
  if (!account) return Response.json({ message: "Sign in is required." }, { status: 401 });
  if (!isDeploymentOwner(account)) return Response.json({ message: "Deployment owner access is required for this Genesis node." }, { status: 403 });
  const bridge = genesisBridge(process.env, { owner: true });
  const id = new URL(request.url).searchParams.get("id");
  return Response.json(id ? await bridge.status(id) : await bridge.capabilities(), { headers: { "cache-control": "no-store" } });
}
