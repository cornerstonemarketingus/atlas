import { githubOAuthConfiguration } from "../../auth/github-oauth.mjs";
import { stripeConfiguration } from "../../billing/stripe.mjs";
import { githubAppConfiguration } from "../../tasks/github-app.mjs";
import { authenticatedAccount } from "../../tasks/operator-auth.mjs";

/**
 * Boolean-only readiness report for the pieces that need external setup
 * (GitHub OAuth App, Stripe) — never returns secret values, just whether
 * each is present. Meant to answer "did the secrets I just set actually
 * take effect after redeploy" without walking the full sign-in/checkout
 * flow by hand.
 */
export async function GET(request: Request) {
  const account = await authenticatedAccount(request);
  if (!account) return Response.json({ message: "Sign in is required." }, { status: 401 });

  const githubOAuth = githubOAuthConfiguration();
  const stripe = stripeConfiguration();
  const githubApp = githubAppConfiguration();

  return Response.json({
    sessionSecretConfigured: Boolean(process.env.ATLAS_SESSION_SECRET),
    githubOAuthConfigured: githubOAuth.configured,
    stripeConfigured: stripe.configured,
    githubDispatchConfigured: githubApp.configured || Boolean(process.env.ATLAS_GITHUB_TOKEN),
    operatorTokenConfigured: Boolean(process.env.ATLAS_OPERATOR_TOKEN),
  });
}
