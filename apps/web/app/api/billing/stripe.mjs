const API_BASE = "https://api.stripe.com/v1";

export function stripeConfiguration(environment = process.env) {
  const secretKey = environment.ATLAS_STRIPE_SECRET_KEY;
  const webhookSecret = environment.ATLAS_STRIPE_WEBHOOK_SECRET;
  const pricePro = environment.ATLAS_STRIPE_PRICE_PRO;
  const priceTeam = environment.ATLAS_STRIPE_PRICE_TEAM;
  if (!secretKey || !webhookSecret || !pricePro || !priceTeam) return { configured: false };
  return { configured: true, secretKey, webhookSecret, prices: { pro: pricePro, team: priceTeam } };
}

function formBody(fields) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null) continue;
    params.set(key, String(value));
  }
  return params;
}

export async function createCheckoutSession(configuration, { tier, customerId, clientReferenceId, successUrl, cancelUrl }, fetcher = fetch) {
  const price = configuration.prices[tier];
  if (!price) throw new Error(`No Stripe price configured for tier '${tier}'.`);
  const response = await fetcher(`${API_BASE}/checkout/sessions`, {
    method: "POST",
    headers: { authorization: `Bearer ${configuration.secretKey}`, "content-type": "application/x-www-form-urlencoded" },
    body: formBody({
      mode: "subscription",
      "line_items[0][price]": price,
      "line_items[0][quantity]": 1,
      success_url: successUrl,
      cancel_url: cancelUrl,
      client_reference_id: clientReferenceId,
      customer: customerId,
      // Stamped onto the resulting Subscription object too, so every later
      // webhook event (renewal, cancellation, payment failure) still carries
      // the tier without us having to resolve it back from a Stripe price id.
      "subscription_data[metadata][tier]": tier,
      // Carried so a subscription event that arrives before
      // checkout.session.completed can still find the right row: without it
      // the update matches nothing and the paying customer stays on free.
      "subscription_data[metadata][atlas_user_id]": clientReferenceId,
    }),
  });
  if (!response.ok) throw new Error(`Stripe checkout session creation failed: ${await safeErrorDetail(response)}`);
  const value = await response.json();
  if (!value || typeof value.url !== "string") throw new Error("Stripe returned no checkout URL.");
  return value.url;
}

export async function createPortalSession(configuration, { customerId, returnUrl }, fetcher = fetch) {
  const response = await fetcher(`${API_BASE}/billing_portal/sessions`, {
    method: "POST",
    headers: { authorization: `Bearer ${configuration.secretKey}`, "content-type": "application/x-www-form-urlencoded" },
    body: formBody({ customer: customerId, return_url: returnUrl }),
  });
  if (!response.ok) throw new Error(`Stripe billing portal session creation failed: ${await safeErrorDetail(response)}`);
  const value = await response.json();
  if (!value || typeof value.url !== "string") throw new Error("Stripe returned no billing portal URL.");
  return value.url;
}

async function safeErrorDetail(response) {
  try {
    const body = await response.json();
    return body?.error?.message ?? `HTTP ${response.status}`;
  } catch {
    return `HTTP ${response.status}`;
  }
}

/**
 * Verifies a Stripe webhook's `Stripe-Signature` header against the raw
 * request body. Must run against the exact bytes Stripe sent — parse JSON
 * only after this returns true.
 */
export async function verifyWebhookSignature(rawBody, signatureHeader, webhookSecret, { toleranceSeconds = 300, now = Date.now() } = {}) {
  if (!signatureHeader || !webhookSecret) return false;
  const fields = signatureHeader.split(",").reduce((accumulator, part) => {
    const [key, value] = part.split("=");
    if (key === "t" || key === "v1") accumulator[key] = value;
    return accumulator;
  }, {});
  const timestamp = Number(fields.t);
  if (!Number.isFinite(timestamp) || !fields.v1) return false;
  if (Math.abs(Math.floor(now / 1000) - timestamp) > toleranceSeconds) return false;

  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(webhookSecret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signatureBytes = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${fields.t}.${rawBody}`));
  const expectedHex = [...new Uint8Array(signatureBytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return timingSafeEqualHex(expectedHex, fields.v1);
}

function timingSafeEqualHex(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
  return diff === 0;
}

/** Collapses Stripe's finer-grained subscription statuses into the three this app tracks. */
export function mapStripeStatus(stripeStatus) {
  if (stripeStatus === "active" || stripeStatus === "trialing") return "active";
  if (stripeStatus === "past_due" || stripeStatus === "unpaid" || stripeStatus === "incomplete") return "past_due";
  return "canceled";
}
