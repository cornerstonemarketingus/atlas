import { governorCall, governorFor } from "../governor-client.mjs";
import { handleGovernorGateway } from "../governor-gateway.mjs";
import { workerEnv } from "../worker-env.mjs";

export async function POST(request: Request) {
  return handleGovernorGateway(request, {
    environment: workerEnv as unknown as Record<string, string | undefined>,
    call: (scope: string, method: string, argument: unknown) => governorCall(governorFor(scope, workerEnv), method, argument),
  });
}
