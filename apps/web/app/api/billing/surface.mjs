/**
 * Where billing may be shown.
 *
 * Apple and Google both take a cut of digital goods sold inside an app, and
 * both reject apps that route around it with an external link. Until the
 * store-billing strategy is decided, the safe and honest position is that the
 * native shells show no prices, no upgrade buttons, and no links to checkout.
 *
 * This is a server-side decision rather than a flag the client sets, because
 * the client asking "am I allowed to show this?" is the client deciding.
 */
export const BILLING_SURFACES = ["web", "ios", "android"];

export function billingSurfaceFor(request, environment = process.env) {
  const header = String(request?.headers?.get?.("x-atlas-client") ?? "web").toLowerCase();
  const surface = BILLING_SURFACES.includes(header) ? header : "web";
  const storeBillingApproved = environment.ATLAS_STORE_BILLING_APPROVED === "true";

  if (surface === "web") return { surface, showBilling: true, reason: null };
  if (storeBillingApproved) return { surface, showBilling: true, reason: "Store billing has been approved for this build." };
  return {
    surface,
    showBilling: false,
    // Said plainly, so the app can show something rather than an empty screen.
    reason: "Billing is managed on the web. Sign in at the Atlas website to change your plan.",
  };
}

/** Prices come from configuration. Atlas never invents one. */
export function priceDisplay(environment = process.env) {
  const configured = {
    pro: environment.ATLAS_PRICE_DISPLAY_PRO ?? null,
    team: environment.ATLAS_PRICE_DISPLAY_TEAM ?? null,
  };
  const missing = Object.entries(configured).filter(([, value]) => !value).map(([tier]) => tier);
  return {
    prices: configured,
    complete: missing.length === 0,
    // A placeholder price is worse than no price: someone will believe it.
    notice: missing.length > 0 ? `No price is configured for: ${missing.join(", ")}. Set ATLAS_PRICE_DISPLAY_* before opening paid sign-ups.` : null,
  };
}
