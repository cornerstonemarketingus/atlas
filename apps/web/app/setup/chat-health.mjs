/**
 * Plain-language readouts of chat provider and quota health for the owner's
 * Connections page.
 *
 * Every sentence here is written in this file. Nothing from the server is
 * echoed except whitelisted enumerations (provider kinds, categories) and
 * numbers, so a provider message, a credential, a secret name or a model id
 * can never reach the page even if a server response were to carry one.
 */

/** Tone of a readout: drives the status-card colour. */
export const TONE = Object.freeze({ GOOD: "good", WARN: "warn", BAD: "bad", UNKNOWN: "unknown" });

const PROVIDER_NAMES = Object.freeze({
  groq: "Groq",
  openai: "OpenAI",
  "workers-ai": "Cloudflare Workers AI",
  "self-hosted": "your own model server",
});

/** A route kind as a person would say it; anything unrecognised is "another provider". */
export function providerName(kind) {
  return Object.hasOwn(PROVIDER_NAMES, kind) ? PROVIDER_NAMES[kind] : "another provider";
}

const isCount = (value) => Number.isInteger(value) && value >= 0;

function sentenceList(names) {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")}, then ${names.at(-1)}`;
}

/**
 * The chat route from `optional.chat` of /api/setup/status: which providers
 * chat tries, in order, and whether anything is configured at all.
 * @returns {{ tone: string, headline: string, detail: string, providers: string[] }}
 */
export function chatRouteSummary(chat) {
  if (!chat || typeof chat !== "object") {
    return { tone: TONE.UNKNOWN, headline: "Chat route not reported", detail: "This deployment did not report how chat is routed. Redeploy to get the current readout.", providers: [] };
  }
  const route = Array.isArray(chat.route) ? chat.route.filter((kind) => typeof kind === "string").slice(0, 5) : [];
  const providers = route.map(providerName);
  if (!providers.length) {
    return {
      tone: TONE.BAD,
      headline: "No chat provider is configured",
      detail: "Chat cannot answer until at least one model provider is set up and the app is redeployed.",
      providers,
    };
  }
  const extras = [];
  if (chat.configured === true && isCount(chat.modelPoolSize) && chat.modelPoolSize > 1) extras.push(`${chat.modelPoolSize} models share the main provider`);
  if (chat.fallbackModelConfigured === true) extras.push("a fallback model is set");
  extras.push(chat.webSearchConfigured === true ? "web search is on" : "web search is off");
  const order = providers.length === 1
    ? `Chat uses ${providers[0]} and has no other provider to fall back on.`
    : `Chat tries ${sentenceList(providers)}.`;
  return {
    tone: providers.length === 1 ? TONE.WARN : TONE.GOOD,
    headline: providers.length === 1 ? `One provider: ${providers[0]}` : `${providers.length} providers in the route`,
    detail: `${order} ${extras.length ? `${extras[0][0].toUpperCase()}${extras.join("; ").slice(1)}.` : ""}`.trim(),
    providers,
  };
}

const PAUSE_REASONS = Object.freeze({
  BILLING: "the provider account is out of credit or quota",
  AUTHENTICATION: "the provider refused the model key",
  PERMISSION: "the model key is not permitted to use these models",
  OTHER: "the provider account refused requests",
});

/** A UTC time as "14:05 UTC" today, or "Oct 21, 14:05 UTC" otherwise; null if unreadable. */
export function utcTime(iso, now = new Date()) {
  const at = typeof iso === "string" ? new Date(iso) : null;
  if (!at || Number.isNaN(at.getTime())) return null;
  const clock = `${String(at.getUTCHours()).padStart(2, "0")}:${String(at.getUTCMinutes()).padStart(2, "0")} UTC`;
  const sameDay = at.getUTCFullYear() === now.getUTCFullYear() && at.getUTCMonth() === now.getUTCMonth() && at.getUTCDate() === now.getUTCDate();
  if (sameDay) return clock;
  const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][at.getUTCMonth()];
  return `${month} ${at.getUTCDate()}, ${clock}`;
}

/**
 * Quota health from `optional.inferenceGovernor` of /api/setup/status: the
 * shared ledger that keeps chat inside each provider's limits.
 * @returns {{ tone: string, headline: string, detail: string }}
 */
export function quotaSummary(governor, now = new Date()) {
  if (!governor || typeof governor !== "object") {
    return { tone: TONE.UNKNOWN, headline: "Quota health not reported", detail: "This deployment did not report quota health. Redeploy to get the current readout." };
  }
  if (governor.bound !== true) {
    return { tone: TONE.WARN, headline: "Quota tracking is off", detail: "Chat still answers, but Atlas cannot pace requests against provider limits, so busy periods may hit rate limits. Redeploy with the inference governor enabled." };
  }
  if (governor.reachable === null) {
    return { tone: TONE.UNKNOWN, headline: "Waiting for a chat provider", detail: "Quota tracking is ready and starts once a chat provider is configured." };
  }
  if (governor.reachable !== true) {
    return { tone: TONE.WARN, headline: "Quota tracking did not answer", detail: "Chat carries on without it, but requests are not being paced against provider limits. Refresh to check again." };
  }
  const pause = governor.accountPause && typeof governor.accountPause === "object" ? governor.accountPause : null;
  if (pause) {
    const reason = PAUSE_REASONS[Object.hasOwn(PAUSE_REASONS, pause.kind) ? pause.kind : "OTHER"];
    const until = utcTime(pause.until, now);
    return {
      tone: TONE.BAD,
      headline: "Main provider paused",
      detail: `Atlas paused the main chat provider because ${reason}.${until ? ` It tries again after ${until}.` : ""} Chat uses a fallback provider meanwhile, if one is configured.`,
    };
  }
  const limited = isCount(governor.limitedModels) ? governor.limitedModels : 0;
  const waiting = isCount(governor.waiting) ? governor.waiting : 0;
  const inFlight = isCount(governor.reservations) ? governor.reservations : 0;
  const tracked = isCount(governor.models) ? governor.models : 0;
  const activity = `${inFlight} request${inFlight === 1 ? "" : "s"} in flight, ${waiting} waiting.`;
  if (limited > 0) {
    return {
      tone: TONE.WARN,
      headline: `${limited} model${limited === 1 ? " is" : "s are"} at a limit`,
      detail: `${limited} of ${Math.max(tracked, limited)} tracked model${Math.max(tracked, limited) === 1 ? "" : "s"} reached a provider rate or daily limit and ${limited === 1 ? "is" : "are"} held back until it resets. ${activity}`,
    };
  }
  return {
    tone: waiting > 0 ? TONE.WARN : TONE.GOOD,
    headline: waiting > 0 ? "Requests are queued" : "Within provider limits",
    detail: tracked ? `No tracked model is at a limit. ${activity}` : `No model has been used since the last reset. ${activity}`,
  };
}

const CATEGORY_TEXT = Object.freeze({
  OK: [TONE.GOOD, "Working", "The credential is accepted and a real test reply came back."],
  CREDENTIAL_MISSING: [TONE.UNKNOWN, "Not set up", "No credential is configured for this provider. Add one to the repository secrets, then redeploy."],
  ACCOUNT_MISSING: [TONE.BAD, "Account not set", "The Cloudflare account this provider runs on is missing or malformed. Add the account id to the repository secrets, then redeploy."],
  CREDENTIAL_INVALID: [TONE.BAD, "Credential not recognised", "The provider does not recognise this credential. Create a new Workers AI API token, replace the stored one, then redeploy."],
  CREDENTIAL_EXPIRED: [TONE.BAD, "Credential expired", "Create a new token, replace the stored one, then redeploy."],
  CREDENTIAL_DISABLED: [TONE.BAD, "Credential disabled", "The token was rolled or paused. Re-enable it or create a new one, then redeploy."],
  WRONG_ACCOUNT_OR_PERMISSION: [TONE.BAD, "Wrong account or permission", "The token works but cannot use Workers AI on the account Atlas runs on. Give it the Workers AI permission on this account."],
  INSUFFICIENT_PERMISSION: [TONE.BAD, "Cannot run models", "The credential can read models but not run them. Give it permission to run Workers AI models."],
  AUTH_SCHEME_MISMATCH: [TONE.BAD, "Wrong kind of token", "The provider accepted the token for its API but not for inference. Use a Workers AI API token."],
  MODEL_UNAVAILABLE: [TONE.BAD, "Model unavailable", "The chosen model is not available to this account. Choose another model, then redeploy."],
  PROVIDER_RATE_LIMIT: [TONE.WARN, "At its limit", "The provider is refusing for now: a rate limit or the free daily allocation, which resets at 00:00 UTC. Wait, or enable paid usage."],
  BILLING_EXHAUSTED: [TONE.WARN, "Daily allocation used", "The free daily allocation is used up. It resets at 00:00 UTC, or enable paid usage."],
  PROVIDER_UNAVAILABLE: [TONE.WARN, "Did not answer", "The provider did not answer as expected. Try the check again shortly."],
  BINDING_MISSING: [TONE.UNKNOWN, "Not connected", "This deployment has no Workers AI binding. It is optional when another provider is configured."],
});

const PROVIDER_CHECKS = Object.freeze([
  ["workersAIBinding", "Workers AI (built-in binding)"],
  ["workersAI", "Workers AI (API token)"],
]);

/**
 * The /api/setup/providers answer as one row per provider check.
 * @returns {{ id: string, label: string, tone: string, headline: string, detail: string }[]}
 */
export function providerChecks(response) {
  const providers = response && typeof response === "object" && response.providers && typeof response.providers === "object" ? response.providers : {};
  return PROVIDER_CHECKS.map(([id, label]) => {
    const category = providers[id]?.category;
    const [tone, headline, detail] = typeof category === "string" && Object.hasOwn(CATEGORY_TEXT, category)
      ? CATEGORY_TEXT[category]
      : [TONE.UNKNOWN, "Not reported", "This check did not report a result. Run it again."];
    return { id, label, tone, headline, detail };
  });
}

/** Status-card class for a tone, matching the existing Connections styles. */
export function toneClass(tone) {
  return tone === TONE.GOOD ? "status-card good" : tone === TONE.BAD ? "status-card bad" : tone === TONE.WARN ? "status-card warn" : "status-card";
}
