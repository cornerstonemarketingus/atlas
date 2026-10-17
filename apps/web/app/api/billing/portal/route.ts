import { customerFailure } from '../../customer-failure.mjs';
import { eq } from "drizzle-orm";
import { getDb } from "../../../../db";
import { subscriptions } from "../../../../db/schema";
import { authenticatedAccount } from "../../tasks/operator-auth.mjs";
import { stripeConfiguration, createPortalSession } from "../stripe.mjs";

async function handlePost(request: Request) {
  const account = await authenticatedAccount(request);
  if (!account || account.dbUserId === null) {
    return Response.json({ message: "Sign in with GitHub is required." }, { status: 401 });
  }

  const configuration = stripeConfiguration();
  if (!configuration.configured) return Response.json({ message: "Billing is not configured yet." }, { status: 503 });

  try {
    const db = getDb();
    const [subscription] = await db.select().from(subscriptions).where(eq(subscriptions.userId, account.dbUserId));
    if (!subscription?.stripeCustomerId) {
      return Response.json({ message: "No billing account yet — subscribe to a plan first." }, { status: 404 });
    }
    const origin = new URL(request.url).origin;
    const url = await createPortalSession(configuration, { customerId: subscription.stripeCustomerId, returnUrl: `${origin}/` });
    return Response.json({ url });
  } catch {
    return customerFailure('portal', 502);
  }
}

export async function POST(request: Request) {
  try { return await handlePost(request); }
  catch { return customerFailure('portal'); }
}
