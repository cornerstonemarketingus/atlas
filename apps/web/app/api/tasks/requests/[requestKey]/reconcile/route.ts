import { getD1 } from "../../../../../../db";
import { authenticatedAccount } from "../../../operator-auth.mjs";
import { resolveTenantContext, tenantScope, NO_TENANT_MESSAGE } from "../../../../auth/tenant-context.mjs";
import { TASK_REQUEST_KEY } from "../../../task-request-contract.mjs";
import { createInstallationToken, githubAppConfiguration } from "../../../github-app.mjs";
import { platformGitHubToken } from "../../../github-token.mjs";
import { reconcileSavedRequest, verifySavedExecution } from "../../../claim-reconciliation.mjs";

const reply = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });

export async function POST(request: Request, context: { params: Promise<{ requestKey: string }> }) {
  try {
    const account = await authenticatedAccount(request);
    if (!account) return reply({ message: "Sign in is required." }, 401);
    const origin = request.headers.get("origin");
    if ((origin !== null && origin !== new URL(request.url).origin) || request.headers.get("sec-fetch-site") === "cross-site") return reply({ message: "Same-origin request required." }, 403);
    const { requestKey } = await context.params;
    if (!TASK_REQUEST_KEY.test(requestKey)) return reply({ message: "Request not found." }, 404);
    try {
      if (request.headers.get("content-type")?.split(";")[0].trim() !== "application/json") throw new Error();
      const reader = request.body?.getReader(); if (!reader) throw new Error();
      let text = ""; let size = 0; const decoder = new TextDecoder();
      try {
        while (true) {
          const { value, done } = await reader.read(); if (done) break;
          size += value.length; if (size > 256) throw new Error(); text += decoder.decode(value, { stream: true });
        }
        text += decoder.decode();
      } finally { await reader.cancel(); }
      const intent = JSON.parse(text);
      if (!intent || Array.isArray(intent) || typeof intent !== "object" || Object.keys(intent).length !== 0) throw new Error();
    } catch { return reply({ message: "Reconciliation requires an empty JSON object." }, 400); }
    const d1 = getD1();
    const tenant = await resolveTenantContext(request, account, d1);
    if (!tenant) return reply({ message: NO_TENANT_MESSAGE }, 403);
    const result = await reconcileSavedRequest(d1, tenantScope(tenant), requestKey.toLowerCase(), async (task, claim) => {
      const app = githubAppConfiguration();
      const token = app.configured ? await createInstallationToken(app) : platformGitHubToken();
      if (!token) throw new Error("Run verification unavailable");
      return verifySavedExecution(task, claim, token);
    });
    if (result.status === "not-found") return reply({ message: "Request not found." }, 404);
    if (result.status !== "observed") return reply({ message: "No matching claimed execution can be reconciled. No task was started." }, 409);
    return reply({ request: result.request, reconciled: true, cached: result.cached });
  } catch { return reply({ message: "Execution evidence is unavailable. No task was started. Refresh saved requests before checking again." }, 503); }
}
