import { workersAIModel } from "./providers.mjs";

/**
 * Provider credential diagnostics: does a configured credential exist, does
 * the provider accept it, is it for the right account, does it carry the
 * permission the call needs, and does a real inference work. A plain "401"
 * says none of that.
 *
 * The answer is categories, HTTP statuses and the provider's numeric error
 * codes only: never the credential, its id, or provider message text (which
 * can echo request content).
 */

export const CREDENTIAL_CATEGORIES = Object.freeze([
  "OK",
  "CREDENTIAL_MISSING",
  "ACCOUNT_MISSING",
  "CREDENTIAL_INVALID",
  "CREDENTIAL_EXPIRED",
  "CREDENTIAL_DISABLED",
  "WRONG_ACCOUNT_OR_PERMISSION",
  "INSUFFICIENT_PERMISSION",
  "AUTH_SCHEME_MISMATCH",
  "MODEL_UNAVAILABLE",
  "PROVIDER_RATE_LIMIT",
  "BILLING_EXHAUSTED",
  "PROVIDER_UNAVAILABLE",
]);

const CLOUDFLARE_API = "https://api.cloudflare.com/client/v4";
const TIMEOUT_MS = 15_000;

const ACTIONS = {
  OK: null,
  CREDENTIAL_MISSING: "Add ATLAS_WORKERS_AI_TOKEN (a Cloudflare API token from the Workers AI template) to the repository secrets, then deploy.",
  ACCOUNT_MISSING: "Add CLOUDFLARE_ACCOUNT_ID (32 hex characters) to the repository secrets, then deploy.",
  CREDENTIAL_INVALID: "Cloudflare does not recognize this token, as a user token or as a token owned by this account. Create a new API token (My Profile → API Tokens → Create Token → Workers AI template; not the Global API Key) and replace ATLAS_WORKERS_AI_TOKEN, then deploy.",
  CREDENTIAL_EXPIRED: "The token has expired. Create a new one from the Workers AI template and replace ATLAS_WORKERS_AI_TOKEN, then deploy.",
  CREDENTIAL_DISABLED: "The token is disabled (rolled or paused). Re-enable it or create a new one, replace ATLAS_WORKERS_AI_TOKEN, then deploy.",
  WRONG_ACCOUNT_OR_PERMISSION: "The token is valid but cannot use Workers AI on the account Atlas runs on: it lacks the Workers AI permission, or it was created for another account. Edit the token: permission Account → Workers AI (Read and Edit), account resources including this account.",
  INSUFFICIENT_PERMISSION: "The token can read Workers AI but cannot run models. Give it the Workers AI Edit permission (the Workers AI template has it).",
  AUTH_SCHEME_MISMATCH: "Cloudflare accepted the token for its API but refused it for inference. Use a Workers AI API token (not an AI Gateway token or the Global API Key).",
  MODEL_UNAVAILABLE: "The model is not available to this account through the OpenAI-compatible endpoint. Set ATLAS_WORKERS_AI_MODEL to another model, e.g. @cf/meta/llama-3.3-70b-instruct-fp8-fast.",
  PROVIDER_RATE_LIMIT: "Workers AI is refusing for now (a rate limit, or the account's free daily allocation, which resets at 00:00 UTC); wait and try again, or enable paid usage on the Workers plan.",
  BILLING_EXHAUSTED: "The account's free Workers AI allocation is used up for today; it resets at 00:00 UTC, or enable paid usage on the Workers plan.",
  PROVIDER_UNAVAILABLE: "Cloudflare did not answer as expected; try again shortly.",
};

/** Cloudflare's numeric error codes from a JSON body (never the messages). */
async function errorCodes(response) {
  try {
    const body = await response.clone().json();
    return Array.isArray(body?.errors) ? body.errors.map((error) => Number(error?.code)).filter(Number.isFinite).slice(0, 5) : [];
  } catch {
    return [];
  }
}

async function call(fetcher, url, token, init = {}) {
  try {
    const response = await fetcher(url, {
      ...init,
      headers: { authorization: `Bearer ${token}`, ...(init.body ? { "content-type": "application/json" } : {}) },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return { status: response.status, codes: await errorCodes(response), response };
  } catch {
    return { status: 0, codes: [], response: null };
  }
}

function report(fields, category) {
  return { provider: "workers-ai", ...fields, category, ...(ACTIONS[category] ? { recommendedAction: ACTIONS[category] } : {}) };
}

/**
 * Diagnoses the Workers AI credential the Worker would use for chat.
 * Steps stop at the first that settles the answer: token verification (as a
 * user token, then as a token owned by the configured account), a read-only
 * Workers AI call on that account, then a minimal inference on the model.
 */
export async function workersAIHealth(environment = process.env, { fetcher = fetch, infer = true } = {}) {
  const token = (environment.ATLAS_WORKERS_AI_TOKEN || "").trim();
  const accountRaw = (environment.CLOUDFLARE_ACCOUNT_ID || "").trim();
  const base = { credential: token ? "configured" : "missing", account: !accountRaw ? "missing" : /^[0-9a-f]{32}$/iu.test(accountRaw) ? "configured" : "invalid" };
  if (!token) return report(base, "CREDENTIAL_MISSING");
  if (base.account !== "configured") return report(base, "ACCOUNT_MISSING");
  const endpoint = workersAIModel(environment);
  const account = accountRaw.toLowerCase();
  const http = {};

  // 1. Is the token known to Cloudflare, and what is its status?
  let verify = await call(fetcher, `${CLOUDFLARE_API}/user/tokens/verify`, token);
  let tokenKind = "user";
  if (verify.status !== 200) {
    const asAccount = await call(fetcher, `${CLOUDFLARE_API}/accounts/${account}/tokens/verify`, token);
    if (asAccount.status === 200) { verify = asAccount; tokenKind = "account"; }
    else http.accountVerify = asAccount.status;
  }
  http.verify = verify.status;
  if (verify.status === 0 || verify.status >= 500) return report({ ...base, http }, "PROVIDER_UNAVAILABLE");
  if (verify.status !== 200) return report({ ...base, validation: "invalid", http, providerErrorCodes: verify.codes }, "CREDENTIAL_INVALID");
  let status = "unknown";
  try { status = String((await verify.response.json())?.result?.status ?? "unknown"); } catch { /* unknown */ }
  const fields = { ...base, validation: status === "active" ? "valid" : status, tokenKind, http };
  if (status === "expired") return report(fields, "CREDENTIAL_EXPIRED");
  if (status === "disabled") return report(fields, "CREDENTIAL_DISABLED");

  // 2. Can it use Workers AI on the account Atlas runs on?
  const models = await call(fetcher, `${CLOUDFLARE_API}/accounts/${account}/ai/models/search?per_page=1`, token);
  http.models = models.status;
  if (models.status === 401 || models.status === 403) return report({ ...fields, workersAI: "denied", providerErrorCodes: models.codes }, "WRONG_ACCOUNT_OR_PERMISSION");
  if (models.status === 429) return report({ ...fields, workersAI: "unknown" }, "PROVIDER_RATE_LIMIT");
  if (models.status !== 200) return report({ ...fields, workersAI: "unknown", providerErrorCodes: models.codes }, "PROVIDER_UNAVAILABLE");
  if (!infer) return report({ ...fields, workersAI: "permitted", inference: "skipped" }, "OK");

  // 3. Does a real inference work, on the exact endpoint and model chat uses?
  const inference = await call(fetcher, new URL("chat/completions", endpoint.baseUrl).toString(), token, {
    method: "POST",
    body: JSON.stringify({ model: endpoint.model, messages: [{ role: "user", content: "Reply with the single word OK." }], max_tokens: 16 }),
  });
  http.inference = inference.status;
  const result = { ...fields, workersAI: "permitted", model: endpoint.model };
  if (inference.status === 200) {
    let answered = false;
    try { answered = Array.isArray((await inference.response.json())?.choices); } catch { /* not an answer */ }
    return report({ ...result, inference: answered ? "ok" : "malformed" }, answered ? "OK" : "PROVIDER_UNAVAILABLE");
  }
  const failed = { ...result, inference: "failed", providerErrorCodes: inference.codes };
  if (inference.status === 401) return report(failed, "AUTH_SCHEME_MISMATCH");
  if (inference.status === 403) return report(failed, "INSUFFICIENT_PERMISSION");
  if (inference.status === 400 || inference.status === 404) return report(failed, "MODEL_UNAVAILABLE");
  // A 429 can also mean the free daily allocation is used up; the codes are returned for that reading.
  if (inference.status === 429) return report(failed, "PROVIDER_RATE_LIMIT");
  return report(failed, "PROVIDER_UNAVAILABLE");
}
