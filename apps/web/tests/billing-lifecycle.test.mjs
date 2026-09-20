import assert from "node:assert/strict";
import test from "node:test";

import { decideEvent, subscriptionChangeFor, mapStatus, entitlement, streamOf, watermarkFor, HANDLED_EVENTS } from "../app/api/billing/idempotency.mjs";
import { decideHostedSession, hostedBrowserAllowance, HOSTED_BROWSER_LIMITS } from "../app/api/billing/hosted-usage.mjs";
import { billingSurfaceFor, priceDisplay } from "../app/api/billing/surface.mjs";

const event = (type, object, { id = "evt_1", created = 1_000 } = {}) => ({ id, type, created, data: { object } });

test("a replayed event is acknowledged and applied only once", () => {
  const first = decideEvent({ event: event("customer.subscription.updated", {}), seen: false });
  assert.equal(first.apply, true);

  const replay = decideEvent({ event: event("customer.subscription.updated", {}), seen: true });
  assert.equal(replay.apply, false);
  assert.equal(replay.duplicate, true);
  // Acknowledged, not errored: an error would be retried forever and Stripe
  // would eventually disable the endpoint.
  assert.equal(replay.acknowledge, true);
});

test("an out-of-order event cannot undo a newer change", () => {
  const stale = decideEvent({
    event: event("customer.subscription.updated", {}, { id: "evt_old", created: 500 }),
    seen: false,
    lastAppliedAt: 1_000,
  });
  assert.equal(stale.apply, false);
  assert.equal(stale.stale, true);
  assert.match(stale.reason, /would undo a newer change/u);

  // The same event is fine when nothing newer has been applied.
  assert.equal(decideEvent({ event: event("customer.subscription.updated", {}, { created: 500 }), seen: false, lastAppliedAt: 400 }).apply, true);
  assert.equal(decideEvent({ event: event("customer.subscription.updated", {}, { created: 500 }), seen: false, lastAppliedAt: null }).apply, true);
});

test("unknown events and malformed ids are acknowledged without action", () => {
  const unknown = decideEvent({ event: event("customer.discount.created", {}), seen: false });
  assert.equal(unknown.apply, false);
  assert.equal(unknown.acknowledge, true);

  const noId = decideEvent({ event: { type: "customer.subscription.updated", created: 1 }, seen: false });
  assert.equal(noId.apply, false);
  assert.match(noId.reason, /no usable id/u);

  for (const type of HANDLED_EVENTS) {
    assert.equal(decideEvent({ event: event(type, {}), seen: false }).apply, true, `${type} must be handled`);
  }
});

test("each event maps to the subscription change it actually implies", () => {
  assert.deepEqual(
    subscriptionChangeFor(event("checkout.session.completed", { client_reference_id: "42", customer: "cus_1" })),
    { kind: "link-customer", userId: 42, customerId: "cus_1" },
  );

  const upgraded = subscriptionChangeFor(event("customer.subscription.updated", {
    id: "sub_1", customer: "cus_1", status: "active", metadata: { tier: "team" }, current_period_end: 1_800_000_000,
  }));
  assert.equal(upgraded.kind, "set-subscription");
  assert.equal(upgraded.tier, "team");
  assert.equal(upgraded.status, "active");
  assert.match(upgraded.currentPeriodEnd, /^20\d\d-/u);

  // A subscription with no Atlas tier is ignored rather than guessed at.
  assert.equal(subscriptionChangeFor(event("customer.subscription.updated", { customer: "cus_1", metadata: {} })).kind, "ignore");

  assert.deepEqual(subscriptionChangeFor(event("customer.subscription.deleted", { id: "sub_1", customer: "cus_1" })), {
    kind: "set-subscription", customerId: "cus_1", tier: "free", status: "canceled", subscriptionId: "sub_1", currentPeriodEnd: null,
  });

  // A failed payment does not cancel: Stripe retries for days, and cutting
  // access on the first failure punishes an expired card over a weekend.
  assert.deepEqual(subscriptionChangeFor(event("invoice.payment_failed", { customer: "cus_1" })), { kind: "set-status", customerId: "cus_1", status: "past_due" });
  // And recovery is handled, or a customer who pays stays past_due forever.
  assert.deepEqual(subscriptionChangeFor(event("invoice.payment_succeeded", { customer: "cus_1" })), { kind: "set-status", customerId: "cus_1", status: "active" });
});

test("Stripe's statuses collapse to the three Atlas acts on", () => {
  for (const status of ["active", "trialing"]) assert.equal(mapStatus(status), "active");
  for (const status of ["past_due", "unpaid", "incomplete"]) assert.equal(mapStatus(status), "past_due");
  for (const status of ["canceled", "incomplete_expired", "paused", undefined]) assert.equal(mapStatus(status), "canceled");
});

test("entitlement keeps a past-due customer working while telling them", () => {
  assert.deepEqual(entitlement("active", "pro"), { tier: "pro", canStartWork: true, notice: null });

  const pastDue = entitlement("past_due", "team");
  assert.equal(pastDue.tier, "team", "the plan is kept while payment is retried");
  assert.equal(pastDue.canStartWork, true);
  assert.match(pastDue.notice, /Update your card/u);

  const canceled = entitlement("canceled", "team");
  assert.equal(canceled.tier, "free");
  assert.equal(canceled.canStartWork, true, "a cancelled customer drops to free, they are not locked out");
  assert.match(canceled.notice, /on the free plan/u);
});

test("hosted browser minutes are metered separately from tasks", () => {
  assert.equal(hostedBrowserAllowance("free").minutesPerMonth, 0);
  assert.equal(hostedBrowserAllowance("pro").minutesPerMonth, HOSTED_BROWSER_LIMITS.pro.minutesPerMonth);
  assert.equal(hostedBrowserAllowance("nonsense").minutesPerMonth, 0, "an unknown tier is free, not unlimited");

  const free = decideHostedSession({ tier: "free", status: "active" });
  assert.equal(free.allowed, false);
  assert.equal(free.code, "PLAN_REQUIRED");
  assert.match(free.message, /at no extra cost/u);

  assert.equal(decideHostedSession({ tier: "pro", status: "active" }).allowed, true);
  assert.equal(decideHostedSession({ tier: "pro", status: "active", activeSessions: 1 }).code, "CONCURRENCY_REACHED");
  assert.equal(decideHostedSession({ tier: "pro", status: "active", minutesUsed: 300 }).code, "QUOTA_EXHAUSTED");
  assert.match(decideHostedSession({ tier: "pro", status: "active", minutesUsed: 300 }).message, /own companion is unaffected/u);

  // A cancelled subscription loses hosted execution even mid-period.
  assert.equal(decideHostedSession({ tier: "pro", status: "canceled" }).code, "PLAN_REQUIRED");
  // A past-due one keeps it while Stripe retries.
  assert.equal(decideHostedSession({ tier: "pro", status: "past_due" }).allowed, true);
});

test("billing is hidden in the native shells until store billing is approved", () => {
  const request = (client) => ({ headers: { get: (name) => (name === "x-atlas-client" ? client : null) } });

  assert.equal(billingSurfaceFor(request("web"), {}).showBilling, true);
  assert.equal(billingSurfaceFor(request(null), {}).showBilling, true, "an unknown client is treated as web");

  for (const platform of ["ios", "android"]) {
    const gated = billingSurfaceFor(request(platform), {});
    assert.equal(gated.showBilling, false, `${platform} must not show prices yet`);
    // Not a blank screen: the app is told what to say.
    assert.match(gated.reason, /managed on the web/u);

    const approved = billingSurfaceFor(request(platform), { ATLAS_STORE_BILLING_APPROVED: "true" });
    assert.equal(approved.showBilling, true);
  }

  // The decision is server-side; a client claiming to be web is still just a
  // header, but the server is the one reading it and deciding.
  assert.equal(billingSurfaceFor(request("IOS"), {}).showBilling, false, "the header is matched case-insensitively");
});

test("prices come from configuration and are never invented", () => {
  const unset = priceDisplay({});
  assert.deepEqual(unset.prices, { pro: null, team: null });
  assert.equal(unset.complete, false);
  assert.match(unset.notice, /No price is configured for: pro, team/u);

  const partial = priceDisplay({ ATLAS_PRICE_DISPLAY_PRO: "$20/month" });
  assert.equal(partial.complete, false);
  assert.match(partial.notice, /team/u);
  assert.equal(partial.notice.includes("pro,"), false);

  const configured = priceDisplay({ ATLAS_PRICE_DISPLAY_PRO: "$20/month", ATLAS_PRICE_DISPLAY_TEAM: "$60/month" });
  assert.equal(configured.complete, true);
  assert.equal(configured.notice, null);
  assert.deepEqual(configured.prices, { pro: "$20/month", team: "$60/month" });
});


test("a subscription event carries the user, so it can land before the checkout does", () => {
  // Stripe does not guarantee order and customer.subscription.created
  // routinely precedes checkout.session.completed — at which point no row
  // carries the customer id. The update matched zero rows, the event was
  // recorded as seen, and the paying customer stayed on free until the next
  // subscription event a month later.
  const change = subscriptionChangeFor({
    id: "evt_1", type: "customer.subscription.created", created: 1_000,
    data: { object: { id: "sub_1", customer: "cus_NEW", status: "active", metadata: { tier: "pro", atlas_user_id: "42" } } },
  });
  assert.equal(change.kind, "set-subscription");
  assert.equal(change.customerId, "cus_NEW");
  assert.equal(change.userId, 42, "the row can be found by user when the customer id is not linked yet");

  // Without the metadata it degrades to NaN rather than matching a wrong row.
  const anonymous = subscriptionChangeFor({
    id: "evt_2", type: "customer.subscription.updated", created: 1_000,
    data: { object: { customer: "cus_X", status: "active", metadata: { tier: "pro" } } },
  });
  assert.equal(Number.isInteger(anonymous.userId), false);
});

test("invoice and subscription events keep separate ordering watermarks", () => {
  assert.equal(streamOf("customer.subscription.updated"), "subscription");
  assert.equal(streamOf("invoice.payment_succeeded"), "invoice");
  assert.equal(streamOf("invoice.payment_failed"), "invoice");
  assert.equal(streamOf("checkout.session.completed"), "subscription");

  // At every renewal Stripe emits both. Sharing one watermark meant that if
  // the invoice (later timestamp) arrived first, the subscription update
  // carrying the new tier was rejected as stale and dropped permanently.
  const subscriptionUpdate = { id: "evt_sub", type: "customer.subscription.updated", created: 1_000, data: { object: {} } };
  // Against the invoice stream's watermark it would have looked stale...
  assert.equal(decideEvent({ event: subscriptionUpdate, seen: false, lastAppliedAt: 2_000 }).apply, false);
  // ...but against its own stream's watermark it applies.
  assert.equal(decideEvent({ event: subscriptionUpdate, seen: false, lastAppliedAt: 500 }).apply, true);
});

test("the watermark read is the one belonging to the event's own stream", () => {
  // A row mid-renewal: the invoice for the new period has been applied, the
  // subscription update carrying the new tier has not.
  const row = { lastEventAt: 500, lastInvoiceEventAt: 2_000 };

  assert.equal(watermarkFor("subscription", row), 500);
  assert.equal(watermarkFor("invoice", row), 2_000);

  // Reading the invoice watermark for a subscription event is what dropped
  // the upgrade; reading its own leaves it applicable.
  const subscriptionUpdate = { id: "evt_sub", type: "customer.subscription.updated", created: 1_000, data: { object: {} } };
  const decision = decideEvent({
    event: subscriptionUpdate,
    seen: false,
    lastAppliedAt: watermarkFor(streamOf(subscriptionUpdate.type), row),
  });
  assert.equal(decision.apply, true);

  // No row yet, and a column never written, both read as "nothing applied"
  // rather than as 0 — which would make every event look newer.
  assert.equal(watermarkFor("invoice", null), null);
  assert.equal(watermarkFor("invoice", { lastEventAt: 500 }), null);
  assert.equal(watermarkFor("subscription", { lastInvoiceEventAt: 2_000 }), null);
});
