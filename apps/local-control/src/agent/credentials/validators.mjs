/**
 * Provider credential checks for the broker. Each takes the secret, calls
 * the provider's own "who am I" endpoint, and returns
 * `{ category, account? }`; a refusal is thrown with `status` and `codes`
 * so the broker can classify it. Nothing here returns or logs the secret,
 * and provider message text is not carried.
 */

class ProviderRefusal extends Error {
  constructor(status, codes = []) {
    super(`The provider refused the credential (${status}).`);
    this.status = status;
    this.codes = codes;
  }
}

async function codesOf(response) {
  try {
    const body = await response.clone().json();
    return Array.isArray(body?.errors) ? body.errors.map((error) => Number(error?.code)).filter(Number.isFinite) : [];
  } catch {
    return [];
  }
}

/** GitHub: the login the token acts as is the account. */
export function githubValidator({ fetcher = fetch } = {}) {
  return async (secret) => {
    const response = await fetcher("https://api.github.com/user", {
      headers: { authorization: `Bearer ${secret}`, accept: "application/vnd.github+json", "user-agent": "atlas-local-control" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new ProviderRefusal(response.status);
    const body = await response.json();
    return { category: "OK", account: typeof body?.login === "string" ? body.login : undefined };
  };
}

/**
 * Cloudflare: the token must be active (as a user token, or one owned by the
 * account), and allowed to use Workers AI on the connection's account id.
 */
export function cloudflareValidator({ accountId, fetcher = fetch } = {}) {
  return async (secret) => {
    const get = (path) => fetcher(`https://api.cloudflare.com/client/v4${path}`, { headers: { authorization: `Bearer ${secret}` }, signal: AbortSignal.timeout(15_000) });
    let verify = await get("/user/tokens/verify");
    if (verify.status !== 200 && accountId) {
      const owned = await get(`/accounts/${accountId}/tokens/verify`);
      if (owned.status === 200) verify = owned;
    }
    if (verify.status !== 200) throw new ProviderRefusal(verify.status, await codesOf(verify));
    const status = (await verify.json())?.result?.status;
    if (status === "expired") return { category: "CREDENTIAL_EXPIRED" };
    if (status !== "active") return { category: "CREDENTIAL_INVALID" };
    if (!accountId) return { category: "OK" };
    const models = await get(`/accounts/${accountId}/ai/models/search?per_page=1`);
    if (models.status !== 200) throw new ProviderRefusal(models.status, await codesOf(models));
    return { category: "OK" };
  };
}
