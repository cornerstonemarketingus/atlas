import { chatProviderChoices, paidChatRoute, resolveChatProvider } from "./providers.mjs";

/**
 * The two chat modes people choose between (docs/atlas-os/ATLAS-CHAT-TIERS.md).
 *
 * Atlas (free) is the whole inference fabric exactly as it was: Automatic
 * rotates across every free provider with the data-trust rule, and every
 * configured model stays selectable (`provider`). Nothing it could reach
 * before is taken away.
 *
 * Super Atlas (paid) routes only to models the deployment pays for
 * (paidChatRoute), and only for an account with an active Pro or Team
 * subscription. When it cannot answer it says why and offers Atlas; it never
 * switches to a free model on its own.
 */
export const ATLAS = "atlas";
export const SUPER_ATLAS = "super-atlas";

/** A requested mode, or null when it is not one. Omitted means Atlas, so older clients keep working. */
export function normalizeChatMode(value) {
  if (value === undefined || value === null || value === ATLAS) return ATLAS;
  return value === SUPER_ATLAS ? SUPER_ATLAS : null;
}

/** Only an active paid subscription unlocks Super Atlas. */
export function hasSuperAtlas(plan) {
  return plan?.status === "active" && ["pro", "team"].includes(plan?.tier);
}

/**
 * Whether this account may use Super Atlas: `{ entitled, code }`. Operator
 * tokens and accounts without a billing record are not subscribers. A billing
 * lookup that fails keeps Super Atlas locked, with its own code, so the
 * person is told to retry rather than to buy a plan they may already have.
 */
export async function superAtlasEntitlement(account, loadPlan) {
  if (!account || account.dbUserId === null || account.dbUserId === undefined) return { entitled: false, code: "SUBSCRIPTION_REQUIRED" };
  try {
    return hasSuperAtlas(await loadPlan(account.dbUserId)) ? { entitled: true, code: null } : { entitled: false, code: "SUBSCRIPTION_REQUIRED" };
  } catch {
    return { entitled: false, code: "ENTITLEMENT_UNAVAILABLE" };
  }
}

const OFFER_ATLAS = "Atlas (free) is available: choose Atlas to keep going.";
const REFUSALS = {
  SUPER_ATLAS_NOT_CONFIGURED: { status: 503, message: `Super Atlas is not available on this deployment: it has no paid model configured (OPENAI_API_KEY, or a vendor marked ATLAS_<VENDOR>_TIER=paid). ${OFFER_ATLAS}` },
  SUBSCRIPTION_REQUIRED: { status: 403, message: `Super Atlas needs an active Pro or Team subscription. ${OFFER_ATLAS}` },
  ENTITLEMENT_UNAVAILABLE: { status: 503, message: `Atlas could not confirm your subscription just now, so Super Atlas stays locked. Try again shortly. ${OFFER_ATLAS}` },
  SUPER_ATLAS_PROVIDER_CHOICE: { status: 400, message: "Super Atlas chooses its own paid models. To pick a specific model, choose Atlas." },
};

/** A refusal body: what happened, a stable code, and the mode that can answer instead. */
export function modeRefusal(code) {
  const refusal = REFUSALS[code];
  return { status: refusal.status, body: { message: refusal.message, code, mode: SUPER_ATLAS, fallbackMode: ATLAS, upgradeUrl: code === "SUBSCRIPTION_REQUIRED" ? "/pricing" : undefined } };
}

/**
 * What a turn in `mode` routes to, decided before anything is written:
 * `{ endpoint }`, or `{ refusal: { status, body } }`.
 *
 * Atlas validates `provider` against the existing choices and resolves it
 * with resolveChatProvider, unchanged. Super Atlas accepts no provider pick
 * other than Automatic, checks the deployment has a paid route, then the
 * entitlement (only then, so nobody is sold a mode the deployment cannot
 * serve).
 */
export async function resolveChatMode({ mode, provider, environment = process.env, bindings = {}, entitlement }) {
  const selection = provider ?? "auto";
  if (mode === ATLAS) {
    if (typeof selection !== "string" || !chatProviderChoices(environment, bindings).some((choice) => choice.id === selection)) {
      return { refusal: { status: 400, body: { message: "Unknown model provider." } } };
    }
    return { endpoint: resolveChatProvider(environment, selection, bindings) };
  }
  if (selection !== "auto") return { refusal: modeRefusal("SUPER_ATLAS_PROVIDER_CHOICE") };
  const route = paidChatRoute(environment);
  if (!route) return { refusal: modeRefusal("SUPER_ATLAS_NOT_CONFIGURED") };
  const access = await entitlement();
  if (!access.entitled) return { refusal: modeRefusal(access.code) };
  return { endpoint: route };
}

/**
 * A Super Atlas turn that no paid model could answer. The paid route has no
 * free provider in it, so this is the honest end: say so and offer Atlas.
 */
export function superAtlasFailure(error) {
  return { message: `Super Atlas could not answer: ${error} Atlas did not switch to a free model for you. ${OFFER_ATLAS}`, code: "SUPER_ATLAS_UNAVAILABLE", mode: SUPER_ATLAS, fallbackMode: ATLAS };
}

/** The mode picker's catalog for this account: availability and, when unavailable, the reason. Never an address or key. */
export async function chatModeChoices({ environment = process.env, bindings = {}, entitlement }) {
  const free = resolveChatProvider(environment, "auto", bindings);
  const paidConfigured = Boolean(paidChatRoute(environment));
  const access = paidConfigured ? await entitlement() : { entitled: false, code: "SUPER_ATLAS_NOT_CONFIGURED" };
  const code = paidConfigured ? access.code : "SUPER_ATLAS_NOT_CONFIGURED";
  return [
    { id: ATLAS, label: "Atlas", paid: false, available: free.configured, reason: free.configured ? null : free.reason ?? null },
    { id: SUPER_ATLAS, label: "Super Atlas", paid: true, available: paidConfigured && access.entitled, configured: paidConfigured, entitled: access.entitled,
      code: paidConfigured && access.entitled ? null : code, reason: paidConfigured && access.entitled ? null : modeRefusal(code).body.message,
      ...(code === "SUBSCRIPTION_REQUIRED" ? { upgradeUrl: "/pricing" } : {}) },
  ];
}
