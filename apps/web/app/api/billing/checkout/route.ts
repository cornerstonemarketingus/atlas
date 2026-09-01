import { eq } from "drizzle-orm";
import { getDb } from "../../../../db";
import { subscriptions } from "../../../../db/schema";
import { authenticatedAccount } from "../../tasks/operator-auth.mjs";
import { stripeConfiguration, createCheckoutSession } from "../stripe.mjs";

const ALLOWED_TIERS = new Set(["pro", "team"]);

export async function POST(request: Request) {
  const account = await authenticatedAccount(request);
  if (!account || account.dbUserId === null) {
    return Response.json({ message: "Sign in with GitHub is required to subscribe." }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ message: "Request body must be valid JSON." }, { status: 400 });
  }
  const tier = (body as { tier?: unknown } | null)?.tier;
  if (typeof tier !== "string" || !ALLOWED_TIERS.has(tier)) {
    return Response.json({ message: "tier must be 'pro' or 'team'." }, { status: 400 });
  }

  const configuration = stripeConfiguration();
  if (!configuration.configured) return Response.json({ message: "Billing is not configured yet." }, { status: 503 });

  try {
    const db = getDb();
    const [subscription] = await db.select().from(subscriptions).where(eq(subscriptions.userId, account.dbUserId));
    const origin = new URL(request.url).origin;
    const url = await createCheckoutSession(configuration, {
      tier,
      customerId: subscription?.stripeCustomerId ?? undefined,
      clientReferenceId: String(account.dbUserId),
      successUrl: `${origin}/?checkout=success`,
      cancelUrl: `${origin}/?checkout=cancelled`,
    });
    return Response.json({ url });
  } catch (error) {
    return Response.json({ message: error instanceof Error ? error.message : "Checkout session creation failed." }, { status: 502 });
  }
}
