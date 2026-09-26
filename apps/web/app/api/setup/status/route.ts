import { sql } from "drizzle-orm";
import { getDb } from "../../../../db";
import { githubOAuthConfiguration } from "../../auth/github-oauth.mjs";
import { stripeConfiguration } from "../../billing/stripe.mjs";
import { createInstallationToken, githubAppConfiguration } from "../../tasks/github-app.mjs";
import { allowedRepositories } from "../../tasks/dispatch.mjs";
import { probeGitHubDispatch } from "../../tasks/github-diagnosis.mjs";
import { authenticatedAccount } from "../../tasks/operator-auth.mjs";
import { platformGitHubToken } from "../../tasks/github-token.mjs";

type StepState = "complete" | "action-required" | "failed";

async function databaseReadiness() {
  try {
    const db = getDb();
    await db.run(sql`SELECT 1 FROM users LIMIT 1`);
    await db.run(sql`SELECT 1 FROM subscriptions LIMIT 1`);
    await db.run(sql`SELECT 1 FROM task_usage LIMIT 1`);
    await db.run(sql`SELECT 1 FROM tasks LIMIT 1`);
    await db.run(sql`SELECT id, installation_id, owner, name, merge_policy, created_at, updated_at FROM repositories LIMIT 1`);
    await db.run(sql`SELECT id FROM installations LIMIT 1`);
    await db.run(sql`SELECT id FROM conversations LIMIT 1`);
    await db.run(sql`SELECT id FROM conversation_messages LIMIT 1`);
    await db.run(sql`SELECT id FROM run_events LIMIT 1`);
    return { binding: true, migrations: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Database readiness check failed.";
    return { binding: !message.includes("binding `DB` is unavailable"), migrations: false };
  }
}

function step(id: string, label: string, complete: boolean, detail: string, action?: string, failed = false) {
  const state: StepState = complete ? "complete" : failed ? "failed" : "action-required";
  return { id, label, state, detail, ...(complete || !action ? {} : { action }) };
}

async function githubDispatchReadiness(githubApp: ReturnType<typeof githubAppConfiguration>) {
  const [repository = "cornerstonemarketingus/atlas"] = [...allowedRepositories(process.env.ATLAS_ALLOWED_REPOSITORIES)];
  let token = platformGitHubToken();
  try {
    if (githubApp.configured) token = await createInstallationToken(githubApp);
  } catch {
    return { ok: false, message: "GitHub App authentication failed.", unblock: "Check the ATLAS_GITHUB_APP_* secrets and redeploy." };
  }
  return probeGitHubDispatch({ token, repository, workflow: process.env.ATLAS_GITHUB_WORKFLOW || "atlas-runner.yml" });
}

/** Readiness metadata only: secret values and credential names never leave the Worker. */
export async function GET(request: Request) {
  const account = await authenticatedAccount(request);
  if (!account) return Response.json({ message: "Sign in is required." }, { status: 401 });

  const githubOAuth = githubOAuthConfiguration();
  const stripe = stripeConfiguration();
  const githubApp = githubAppConfiguration();
  const database = await databaseReadiness();
  const sessionSecretConfigured = Boolean(process.env.ATLAS_SESSION_SECRET);
  const githubDispatchConfigured = githubApp.configured || Boolean(platformGitHubToken());
  const workerSecretsConfigured = sessionSecretConfigured && githubOAuth.configured && githubDispatchConfigured;
  // "Ready" means the credential works, not merely that one is set: a
  // read-only look at the workflow Atlas would dispatch.
  const dispatch = await githubDispatchReadiness(githubApp);
  const steps = [
    step("github-actions", "GitHub Actions access", dispatch.ok, dispatch.ok ? "Atlas's GitHub credential can reach its task workflow." : `${dispatch.message} ${dispatch.unblock ?? ""}`.trim(), "Connect GitHub", githubDispatchConfigured && !dispatch.ok),
    step("d1-permission", "Cloudflare D1 access", database.binding, database.binding ? "The Worker can reach its D1 binding." : "The DB binding is unavailable to the live Worker.", "Configure D1 binding", !database.binding),
    step("d1-database", "D1 database selected", database.binding, database.binding ? "A database is connected as DB." : "Select or create a D1 database.", "Select database"),
    step("migrations", "Database migrations", database.migrations, database.migrations ? "Required application tables are readable." : "Apply the pending database migrations.", "Run migrations", database.binding && !database.migrations),
    step("github-oauth", "GitHub sign-in", githubOAuth.configured, githubOAuth.configured ? "GitHub OAuth credentials are active." : "Create or connect the GitHub application.", "Configure GitHub sign-in"),
    step("worker-secrets", "Runtime secrets", workerSecretsConfigured, workerSecretsConfigured ? "Required runtime credentials are configured." : "One or more required runtime credentials are missing.", "Upload runtime secrets"),
    step("deployment", "Live deployment", database.binding && workerSecretsConfigured, database.binding && workerSecretsConfigured ? "The deployed Worker has its required runtime configuration." : "Redeploy after database and secrets are ready.", "Deploy Atlas"),
    step("verification", "Sign-in verification", database.migrations && githubOAuth.configured && sessionSecretConfigured, database.migrations && githubOAuth.configured && sessionSecretConfigured ? "Atlas is ready for a clean GitHub sign-in test." : "Finish the blocked setup steps before testing sign-in.", "Verify sign-in"),
  ];
  const completedSteps = steps.filter((item) => item.state === "complete").length;

  return Response.json({
    version: 1,
    overall: completedSteps === steps.length ? "ready" : steps.some((item) => item.state === "failed") ? "blocked" : "setup-required",
    completedSteps,
    totalSteps: steps.length,
    steps,
    optional: { stripeConfigured: stripe.configured },
  }, { headers: { "cache-control": "no-store" } });
}
