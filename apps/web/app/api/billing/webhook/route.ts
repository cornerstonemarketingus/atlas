import { eq } from "drizzle-orm";
import { getDb } from "../../../../db";
import { billingEvents, subscriptions } from "../../../../db/schema";
import { stripeConfiguration, verifyWebhookSignature } from "../stripe.mjs";
import { decideEvent, subscriptionChangeFor } from "../idempotency.mjs";

export async function POST(request: Request) {
  const configuration = stripeConfiguration();
  if (!configuration.configured) return Response.json({ message: "Billing is not configured." }, { status: 503 });

  // Signature verification needs the exact raw bytes Stripe signed — parse
  // JSON only after it passes.
  const rawBody = await request.text();
  const signature = request.headers.get("stripe-signature");
  const valid = await verifyWebhookSignature(rawBody, signature, configuration.webhookSecret);
  if (!valid) return Response.json({ message: "Invalid signature." }, { status: 400 });

  let event: { id?: string; type?: string; created?: number; data?: { object?: Record<string, unknown> } };
  try {
    event = JSON.parse(rawBody);
  } catch {
    return Response.json({ message: "Malformed event body." }, { status: 400 });
  }

  const db = getDb();
  const now = new Date().toISOString();

  // Has this exact event already been applied? Stripe retries on timeouts, on
  // 500s, and on a deploy that lands mid-request.
  const [seen] = await db.select().from(billingEvents).where(eq(billingEvents.id, String(event.id ?? "")));
  // The change modules are plain JS, so their union is narrowed here rather
  // than inferred: an untyped `change.userId` reaching a query is exactly the
  // kind of thing that only fails once it is in production.
  const change = subscriptionChangeFor(event) as {
    kind: string;
    userId?: number;
    customerId?: string | null;
    tier?: "pro" | "team" | "free";
    status?: "active" | "past_due" | "canceled";
    subscriptionId?: string | null;
    currentPeriodEnd?: string | null;
  };
  const customerId = change.customerId ?? null;
  const [existing] = customerId
    ? await db.select().from(subscriptions).where(eq(subscriptions.stripeCustomerId, customerId))
    : [];

  const decide = decideEvent as (input: {
    event: unknown;
    seen: boolean;
    lastAppliedAt: number | null;
  }) => { apply: boolean; reason: string | null; createdAt?: number | null };
  const decision = decide({ event, seen: Boolean(seen), lastAppliedAt: existing?.lastEventAt ?? null });
  if (!decision.apply) {
    // Always 200. A replay answered with an error is retried forever, and
    // Stripe eventually disables the endpoint.
    return Response.json({ received: true, applied: false, reason: decision.reason });
  }

  switch (change.kind) {
    case "link-customer": {
      const userId = Number(change.userId);
      if (Number.isInteger(userId) && change.customerId) {
        await db.update(subscriptions)
          .set({ stripeCustomerId: change.customerId, updatedAt: now })
          .where(eq(subscriptions.userId, userId));
      }
      break;
    }
    case "set-subscription": {
      if (change.customerId) {
        await db.update(subscriptions)
          .set({
            tier: change.tier ?? "free",
            status: change.status ?? "canceled",
            stripeSubscriptionId: change.subscriptionId ?? undefined,
            currentPeriodEnd: change.currentPeriodEnd ?? null,
            lastEventAt: decision.createdAt ?? null,
            updatedAt: now,
          })
          .where(eq(subscriptions.stripeCustomerId, change.customerId));
      }
      break;
    }
    case "set-status": {
      // A failed payment marks past_due rather than cancelling: Stripe retries
      // for days, and cutting access on the first failure punishes a customer
      // whose card expired over a weekend.
      if (change.customerId) {
        await db.update(subscriptions)
          .set({ status: change.status ?? "active", lastEventAt: decision.createdAt ?? null, updatedAt: now })
          .where(eq(subscriptions.stripeCustomerId, change.customerId));
      }
      break;
    }
    default:
      break;
  }

  // Recorded after the change, so a crash mid-apply leaves the event
  // unrecorded and Stripe's retry replays it rather than skipping it.
  await db.insert(billingEvents)
    .values({ id: String(event.id), type: String(event.type ?? "unknown"), createdAt: Number(event.created ?? 0), receivedAt: now })
    .onConflictDoNothing();

  return Response.json({ received: true, applied: true });
}
