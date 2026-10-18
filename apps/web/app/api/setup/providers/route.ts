import { workersAIHealth } from "../../chat/provider-health.mjs";
import { chatRoute } from "../../chat/providers.mjs";
import { workersAIBindingHealth } from "../../chat/workers-ai-binding.mjs";
import { workerEnv } from "../../inference/worker-env.mjs";
import { authenticatedAccount } from "../../tasks/operator-auth.mjs";

/**
 * Owner-only provider diagnostics: whether each configured model provider's
 * credential exists, is accepted, belongs to the right account, carries the
 * needed permission, and serves a real inference. Categories, statuses and
 * provider error codes only; never a credential or provider message text.
 */
export async function GET(request: Request) {
  const account = await authenticatedAccount(request);
  if (!account) return Response.json({ message: "Sign in is required." }, { status: 401 });
  if (account.userId !== "operator") return Response.json({ message: "Only the owner can run provider diagnostics." }, { status: 403 });
  const bindings = { ai: (workerEnv as { AI?: unknown }).AI };
  const [workersAI, workersAIBinding] = await Promise.all([workersAIHealth(process.env), workersAIBindingHealth(bindings, process.env)]);
  return Response.json({ version: 1, route: chatRoute(process.env, bindings), providers: { workersAI, workersAIBinding } }, { headers: { "cache-control": "no-store" } });
}
