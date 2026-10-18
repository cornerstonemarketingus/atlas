import { getD1 } from "../../../../../db";
import { resolveTenantContext } from "../../../auth/tenant-context.mjs";
import { authenticatedAccount } from "../../operator-auth.mjs";
import { createInstallationToken, githubAppConfiguration } from "../../github-app.mjs";
import { platformGitHubToken } from "../../github-token.mjs";
import { cancelHostedTask } from "../../cancel-task.mjs";

export async function POST(request: Request, context: { params: Promise<{ taskId: string }> }) {
  const { taskId } = await context.params;
  return cancelHostedTask(request, taskId, {
    authenticate: authenticatedAccount,
    tenantContext: resolveTenantContext,
    database: getD1,
    githubToken: async () => {
      const app = githubAppConfiguration();
      return app.configured ? createInstallationToken(app) : platformGitHubToken();
    },
  });
}
