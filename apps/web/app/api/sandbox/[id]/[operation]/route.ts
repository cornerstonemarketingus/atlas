import { getD1 } from "../../../../../db";
import { workerEnv } from "../../../inference/worker-env.mjs";
import { resolveTenantContext } from "../../../auth/tenant-context.mjs";
import { authenticatedAccount } from "../../../tasks/operator-auth.mjs";
import { isDeploymentOwner } from "../../../tasks/self-protection.mjs";
import { handleSandboxRequest } from "../../broker.mjs";

type Context = { params: Promise<{ id: string; operation: string }> };

// exec, files, tree, snapshot, restore, preview on one cloud environment; see ../../broker.mjs.
async function handle(request: Request, context: Context) {
  const { id, operation } = await context.params;
  return handleSandboxRequest(request, { id, operation }, {
    authenticate: (incoming: Request) => authenticatedAccount(incoming),
    isOwner: isDeploymentOwner,
    resolveTenant: (incoming: Request, account: unknown) => resolveTenantContext(incoming, account, getD1()),
    environment: workerEnv,
  });
}

export async function GET(request: Request, context: Context) { return handle(request, context); }
export async function POST(request: Request, context: Context) { return handle(request, context); }
export async function PUT(request: Request, context: Context) { return handle(request, context); }
