/**
 * Where billing may be shown.
 *
 * Apple and Google both take a cut of digital goods sold inside an app, and
 * both reject apps that route around it with an external link. Until the
 * store-billing strategy is decided, the safe and honest position is that the
 * native shells show no prices, no upgrade buttons, and no links to checkout.
 *
 * What this is, precisely: `x-atlas-client` is a header the client sets, so
 * it is a declaration and not a proof. Anyone can send `x-atlas-client: web`
 * from a native build and be shown billing. That is acceptable here and it is
 * worth being exact about why, because the earlier note claimed this was a
 * server-side decision that the client could not make, which it is not.
 *
 * The thing being avoided is a store rejection, and the reviewer's build
 * sends the header its own shell sends. A user who spoofs the header is not
 * defeating a security boundary -- they reach the same web checkout they
 * could have opened in a browser, and Atlas is paid either way. So the header
 * is trusted for what it is good for: deciding what to render. Nothing that
 * grants entitlement is decided from it.
 */
export const BILLING_SURFACES = ["web", "ios", "android"];

export function billingSurfaceFor(request, environment = process.env) {
  // Absent or unrecognised means web: a new client that forgets the header
  // gets the working surface rather than a blank one.
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
