import assert from "node:assert/strict";
import test from "node:test";
import {
  stripeConfiguration,
  createCheckoutSession,
  createPortalSession,
  verifyWebhookSignature,
  mapStripeStatus,
} from "../app/api/billing/stripe.mjs";

const FULL_ENV = {
  ATLAS_STRIPE_SECRET_KEY: "sk_test_123",
  ATLAS_STRIPE_WEBHOOK_SECRET: "whsec_123",
  ATLAS_STRIPE_PRICE_PRO: "price_pro",
  ATLAS_STRIPE_PRICE_TEAM: "price_team",
};

test("reports unconfigured unless every secret and price id is present", () => {
  assert.equal(stripeConfiguration({}).configured, false);
  assert.equal(stripeConfiguration({ ATLAS_STRIPE_SECRET_KEY: "sk" }).configured, false);
  assert.equal(stripeConfiguration(FULL_ENV).configured, true);
});

test("creates a checkout session carrying tier metadata and the caller's ids", async () => {
  let observedBody;
  const fetcher = async (_url, init) => {
    observedBody = new URLSearchParams(init.body);
    return new Response(JSON.stringify({ url: "https://checkout.stripe.com/session123" }), { status: 200 });
  };
  const configuration = stripeConfiguration(FULL_ENV);
  const url = await createCheckoutSession(
    configuration,
    { tier: "pro", customerId: undefined, clientReferenceId: "42", successUrl: "https://a/s", cancelUrl: "https://a/c" },
    fetcher,
  );
  assert.equal(url, "https://checkout.stripe.com/session123");
  assert.equal(observedBody.get("line_items[0][price]"), "price_pro");
  assert.equal(observedBody.get("client_reference_id"), "42");
  assert.equal(observedBody.get("subscription_data[metadata][tier]"), "pro");
  assert.equal(observedBody.has("customer"), false);
});

test("rejects an unknown tier before calling Stripe", async () => {
  const configuration = stripeConfiguration(FULL_ENV);
  await assert.rejects(
    createCheckoutSession(configuration, { tier: "enterprise", clientReferenceId: "1", successUrl: "https://a", cancelUrl: "https://a" }, async () => {
      throw new Error("should not be called");
    }),
    /No Stripe price configured/u,
  );
});

test("surfaces Stripe's error message on a failed checkout session request", async () => {
  const fetcher = async () => new Response(JSON.stringify({ error: { message: "No such price" } }), { status: 400 });
  const configuration = stripeConfiguration(FULL_ENV);
  await assert.rejects(
    createCheckoutSession(configuration, { tier: "pro", clientReferenceId: "1", successUrl: "https://a", cancelUrl: "https://a" }, fetcher),
    /No such price/u,
  );
});

test("creates a billing portal session for an existing customer", async () => {
  let observedBody;
  const fetcher = async (_url, init) => {
    observedBody = new URLSearchParams(init.body);
    return new Response(JSON.stringify({ url: "https://billing.stripe.com/portal123" }), { status: 200 });
  };
  const configuration = stripeConfiguration(FULL_ENV);
  const url = await createPortalSession(configuration, { customerId: "cus_123", returnUrl: "https://a/" }, fetcher);
  assert.equal(url, "https://billing.stripe.com/portal123");
  assert.equal(observedBody.get("customer"), "cus_123");
});

test("verifies a correctly signed webhook payload", async () => {
  const secret = "whsec_test";
  const body = JSON.stringify({ type: "checkout.session.completed" });
  const timestamp = 1_700_000_000;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signatureBytes = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}.${body}`));
  const hex = [...new Uint8Array(signatureBytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const header = `t=${timestamp},v1=${hex}`;

  assert.equal(await verifyWebhookSignature(body, header, secret, { now: timestamp * 1000 }), true);
});

test("rejects a webhook with a wrong signature, wrong secret, missing header, or stale timestamp", async () => {
  const secret = "whsec_test";
  const body = JSON.stringify({ type: "ping" });
  assert.equal(await verifyWebhookSignature(body, null, secret), false);
  assert.equal(await verifyWebhookSignature(body, "t=1700000000,v1=deadbeef", secret, { now: 1_700_000_000_000 }), false);

  const timestamp = 1_700_000_000;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signatureBytes = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}.${body}`));
  const hex = [...new Uint8Array(signatureBytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const header = `t=${timestamp},v1=${hex}`;
  // Nine minutes later — outside the default five-minute tolerance.
  assert.equal(await verifyWebhookSignature(body, header, secret, { now: (timestamp + 9 * 60) * 1000 }), false);
  assert.equal(await verifyWebhookSignature(body, header, "wrong-secret", { now: timestamp * 1000 }), false);
});

test("maps Stripe's finer-grained statuses onto the three this app tracks", () => {
  assert.equal(mapStripeStatus("active"), "active");
  assert.equal(mapStripeStatus("trialing"), "active");
  assert.equal(mapStripeStatus("past_due"), "past_due");
  assert.equal(mapStripeStatus("unpaid"), "past_due");
  assert.equal(mapStripeStatus("incomplete"), "past_due");
  assert.equal(mapStripeStatus("canceled"), "canceled");
  assert.equal(mapStripeStatus("incomplete_expired"), "canceled");
  assert.equal(mapStripeStatus("paused"), "canceled");
});
