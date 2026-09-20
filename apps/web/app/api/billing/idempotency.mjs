/**
 * Making Stripe webhooks safe to receive twice, and out of order.
 *
 * Stripe retries. It retries on a timeout, on a 500, and on a deploy that
 * happened mid-request, so the same event arrives more than once as a matter
 * of routine rather than as an edge case. It also does not guarantee ordering,
 * which is the more dangerous half: an older `customer.subscription.updated`
 * landing after a newer one would downgrade a customer who just upgraded.
 *
 * Two guards, both pure so they can be tested without a database:
 * dedupe by event id, and refuse to apply an event older than the last one
 * already applied to that subscription.
 */
export const HANDLED_EVENTS = new Set([
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "invoice.payment_failed",
  "invoice.payment_succeeded",
]);

/**
 * @param seen whether this event id has already been processed
 * @param lastAppliedAt epoch seconds of the newest event applied to this
 *   subscription, or null when none has been
 */
/**
 * Watermarks are kept per stream.
 *
 * Subscription events and invoice events are two unordered streams sharing one
 * `last_event_at` column. At every renewal Stripe emits both; if the invoice
 * arrived first its timestamp became the watermark and the subscription
 * update — carrying the new tier and period end — was rejected as stale and
 * dropped permanently. An upgrade paid for at renewal simply did not apply.
 */
export function streamOf(type) {
  return String(type ?? "").startsWith("invoice.") ? "invoice" : "subscription";
}

/**
 * The watermark an event must be compared against, given its stream.
 *
 * Picking the column here rather than at the call site is deliberate: reading
 * the wrong one is silent — no error, no failing write, just a renewal's tier
 * change quietly rejected as stale.
 *
 * @param stream "invoice" or "subscription", from {@link streamOf}
 * @param row the subscription row, or null when none matches yet
 */
export function watermarkFor(stream, row) {
  if (!row) return null;
  const value = stream === "invoice" ? row.lastInvoiceEventAt : row.lastEventAt;
  return value ?? null;
}

export function decideEvent({ event, seen, lastAppliedAt = null }) {
  const type = String(event?.type ?? "");
  const id = String(event?.id ?? "");

  if (!id.startsWith("evt_")) return { apply: false, reason: "The event carries no usable id.", acknowledge: true };
  if (!HANDLED_EVENTS.has(type)) return { apply: false, reason: `Nothing to do for '${type}'.`, acknowledge: true };

  // Acknowledged, not retried: a replay that returns an error would be
  // retried forever, and Stripe would eventually disable the endpoint.
  if (seen) return { apply: false, reason: "This event was already processed.", acknowledge: true, duplicate: true };

  const created = Number(event?.created);
  if (Number.isFinite(created) && lastAppliedAt !== null && created < lastAppliedAt) {
    return {
      apply: false,
      reason: `This event is older than one already applied (${created} < ${lastAppliedAt}); applying it would undo a newer change.`,
      acknowledge: true,
      stale: true,
    };
  }

  return { apply: true, reason: null, acknowledge: true, createdAt: Number.isFinite(created) ? created : null };
}

/**
 * The subscription state an event implies.
 *
 * Failed payment does not cancel a subscription: Stripe retries for days, and
 * cutting access on the first failure punishes a customer whose card expired
 * over a weekend. It is marked past_due, which keeps the plan while making the
 * state visible.
 */
export function subscriptionChangeFor(event) {
  const object = event?.data?.object ?? {};
  switch (event?.type) {
    case "checkout.session.completed":
      return { kind: "link-customer", userId: Number(object.client_reference_id), customerId: str(object.customer) };
    case "customer.subscription.created":
    case "customer.subscription.updated": {
      const tier = object.metadata?.tier;
      if (tier !== "pro" && tier !== "team") return { kind: "ignore", reason: "The subscription carries no Atlas tier." };
      return {
        kind: "set-subscription",
        customerId: str(object.customer),
        // Stripe does not guarantee order, and `customer.subscription.created`
        // routinely arrives before `checkout.session.completed` — at which
        // point no row carries this customer id yet. Carrying the user through
        // lets the write find the row either way, instead of updating zero
        // rows and being permanently deduped while the customer stays on free.
        userId: Number(object.metadata?.atlas_user_id ?? NaN),
        tier,
        status: mapStatus(object.status),
        subscriptionId: str(object.id),
        currentPeriodEnd: typeof object.current_period_end === "number" ? new Date(object.current_period_end * 1000).toISOString() : null,
      };
    }
    case "customer.subscription.deleted":
      return { kind: "set-subscription", customerId: str(object.customer), tier: "free", status: "canceled", subscriptionId: str(object.id), currentPeriodEnd: null };
    case "invoice.payment_failed":
      return { kind: "set-status", customerId: str(object.customer), status: "past_due" };
    case "invoice.payment_succeeded":
      // Recovery has to be handled too, or a customer who pays stays past_due.
      return { kind: "set-status", customerId: str(object.customer), status: "active" };
    default:
      return { kind: "ignore", reason: `Unhandled event type '${event?.type}'.` };
  }
}

/** Stripe's finer-grained statuses, mapped to the three Atlas acts on. */
export function mapStatus(status) {
  if (status === "active" || status === "trialing") return "active";
  if (status === "past_due" || status === "unpaid" || status === "incomplete") return "past_due";
  return "canceled";
}

/** What a given status may still do. Enforced server-side, never in the client. */
export function entitlement(status, tier) {
  if (status === "active") return { tier, canStartWork: true, notice: null };
  if (status === "past_due") {
    return {
      // The plan is kept while payment is retried, and the customer is told.
      tier,
      canStartWork: true,
      notice: "A payment did not go through. Update your card in the billing portal to avoid losing access.",
    };
  }
  return { tier: "free", canStartWork: true, notice: "Your subscription has ended. You are on the free plan." };
}

function str(value) {
  return typeof value === "string" ? value : null;
}
