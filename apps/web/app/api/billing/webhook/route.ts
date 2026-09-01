import { eq } from "drizzle-orm";
import { getDb } from "../../../../db";
import { subscriptions } from "../../../../db/schema";
import { stripeConfiguration, verifyWebhookSignature, mapStripeStatus } from "../stripe.mjs";

export async function POST(request: Request) {
  const configuration = stripeConfiguration();
  if (!configuration.configured) return Response.json({ message: "Billing is not configured." }, { status: 503 });

  // Signature verification needs the exact raw bytes Stripe signed — parse
  // JSON only after it passes.
  const rawBody = await request.text();
  const signature = request.headers.get("stripe-signature");
  const valid = await verifyWebhookSignature(rawBody, signature, configuration.webhookSecret);
  if (!valid) return Response.json({ message: "Invalid signature." }, { status: 400 });

  let event: { type?: unknown; data?: { object?: Record<string, unknown> } };
  try {
    event = JSON.parse(rawBody);
  } catch {
    return Response.json({ message: "Malformed event body." }, { status: 400 });
  }

  const db = getDb();
  const object = event.data?.object;
  const now = new Date().toISOString();

  // Stripe doesn't contractually guarantee delivery order, but in practice
  // checkout.session.completed (which persists stripeCustomerId) arrives
  // before the subscription events below that key off it — an out-of-order
  // delivery would just leave that one subscription un-synced until its
  // next update, not misattribute it to a different account.
  switch (event.type) {
    case "checkout.session.completed": {
      const dbUserId = Number(object?.client_reference_id);
      const customerId = object?.customer;
      if (Number.isInteger(dbUserId) && typeof customerId === "string") {
        await db.update(subscriptions).set({ stripeCustomerId: customerId, updatedAt: now }).where(eq(subscriptions.userId, dbUserId));
      }
      break;
    }
    case "customer.subscription.created":
    case "customer.subscription.updated": {
      const metadata = object?.metadata as Record<string, unknown> | undefined;
      const tier = metadata?.tier;
      const customerId = object?.customer;
      if ((tier === "pro" || tier === "team") && typeof customerId === "string") {
        const status = mapStripeStatus(object?.status);
        const currentPeriodEnd = typeof object?.current_period_end === "number" ? new Date(object.current_period_end * 1000).toISOString() : null;
        await db
          .update(subscriptions)
          .set({ tier, status, stripeSubscriptionId: object?.id as string | undefined, currentPeriodEnd, updatedAt: now })
          .where(eq(subscriptions.stripeCustomerId, customerId));
      }
      break;
    }
    case "customer.subscription.deleted": {
      const customerId = object?.customer;
      if (typeof customerId === "string") {
        await db.update(subscriptions).set({ tier: "free", status: "canceled", updatedAt: now }).where(eq(subscriptions.stripeCustomerId, customerId));
      }
      break;
    }
    default:
      break;
  }

  return Response.json({ received: true });
}
