import { CredentialError } from "./broker.mjs";

/**
 * /v1/accounts — the credential broker's connections, as the owner sees them.
 *
 * GET    /v1/accounts                 connections (never a value), approval mode, capability catalog
 * POST   /v1/accounts                 connect: { provider, account, environment, type, vaultRef, capabilities, expiresAt, secret? }
 * DELETE /v1/accounts/:id             revoke (the vault value is removed)
 * POST   /v1/accounts/:id/validate    check the credential with the provider, when a validator exists
 * PUT    /v1/accounts/mode            { mode: SAFE | BALANCED | AUTONOMOUS }
 * GET    /v1/accounts/audit           the append-only use trail (credential references, never values)
 *
 * Reading is open to paired devices; every write is the owner's.
 */
export function createAccountRoutes({ broker, validators = {}, capabilities, send }) {
  return async function handle(request, response, identity) {
    const url = new URL(request.url ?? "/", "http://local.atlas");
    if (!url.pathname.startsWith("/v1/accounts")) return false;
    const owner = identity.role === "admin";
    const write = request.method !== "GET";
    if (write && !owner) return send(response, 403, { message: "Only the local owner can change accounts." });
    try {
      if (url.pathname === "/v1/accounts" && request.method === "GET") {
        return send(response, 200, { accounts: broker.connections(), mode: broker.mode, capabilities });
      }
      if (url.pathname === "/v1/accounts/audit" && request.method === "GET") {
        if (!owner) return send(response, 403, { message: "Only the local owner can read the credential audit trail." });
        return send(response, 200, { audit: broker.auditTrail(200) });
      }
      if (url.pathname === "/v1/accounts/mode" && request.method === "PUT") {
        const body = await readJson(request);
        return send(response, 200, { mode: broker.setMode(body?.mode) });
      }
      if (url.pathname === "/v1/accounts" && request.method === "POST") {
        const body = await readJson(request);
        if (!body) return send(response, 400, { message: "Request body must be a JSON object." });
        return send(response, 201, { account: await broker.connect(body) });
      }
      const match = /^\/v1\/accounts\/([0-9a-f-]{36})(\/validate)?$/u.exec(url.pathname);
      if (match && request.method === "DELETE" && !match[2]) return send(response, 200, { account: await broker.revoke(match[1]) });
      if (match && request.method === "POST" && match[2]) {
        const account = broker.connections().find((entry) => entry.id === match[1]);
        if (!account) return send(response, 404, { message: "Connection not found." });
        // A validator is built for the connection's own account (e.g. a Cloudflare account id).
        const build = validators[account.provider];
        if (!build) return send(response, 409, { message: `Atlas cannot check ${account.provider} credentials yet.` });
        return send(response, 200, { account: await broker.validate(match[1], build(account.account)) });
      }
      return send(response, 404, { message: "Route not found." });
    } catch (error) {
      if (error instanceof CredentialError) return send(response, error.code === "UNKNOWN_CONNECTION" ? 404 : 400, { code: error.code, message: error.message });
      // The vault refusing (no keyring, wrong passphrase) is a setup problem, not a crash; never echo the value.
      if (error?.name === "VaultError") return send(response, 503, { code: error.code ?? "VAULT_UNAVAILABLE", message: "The credential vault on this computer refused the request. On Linux install the system keyring (secret-tool, from libsecret); macOS Keychain and Windows DPAPI are built in." });
      return send(response, 500, { code: "ACCOUNTS_FAILED", message: "The accounts request failed." });
    }
  };
}

async function readJson(request) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 64 * 1024) return null;
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}
