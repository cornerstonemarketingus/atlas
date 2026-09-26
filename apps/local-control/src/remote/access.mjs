import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { runCommand } from "../agent/tools/process.mjs";

/**
 * Reaching your own Atlas from your phone without any Atlas or cloud relay.
 *
 * Atlas keeps listening on 127.0.0.1 only. The owner chooses one of two
 * customer-managed paths, and Atlas guides and checks it:
 *
 * 1. Private VPN (Tailscale, or Headscale for a self-hosted control server):
 *    `tailscale serve` publishes the loopback port as HTTPS on the owner's own
 *    tailnet, with a certificate for the machine's tailnet name. It is never
 *    `funnel`: nothing becomes reachable from the public internet. Atlas can
 *    turn this on and off, and reports the address.
 * 2. Your own HTTPS reverse proxy (Caddy, nginx, or anything on your VPN or
 *    domain) in front of 127.0.0.1. Atlas generates the configuration and
 *    records the HTTPS address you use.
 *
 * Either way, remote devices sign in by pairing (a one-use code shown on this
 * computer, which gives the phone its own revocable token). The owner token is
 * refused on any proxied or non-loopback request unless the owner explicitly
 * allows it, so a leaked sign-in link is useless off this machine.
 */

const PROXY_HEADERS = ["x-forwarded-for", "forwarded", "x-real-ip", "tailscale-user-login", "cf-connecting-ip"];
const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/** A request that arrived through a proxy or from another machine. */
export function isRemoteRequest(request) {
  if (PROXY_HEADERS.some((header) => request.headers?.[header] !== undefined)) return true;
  return !LOOPBACK.has(request.socket?.remoteAddress ?? "");
}

export class RemoteAccessError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "RemoteAccessError";
    this.code = code;
  }
}

/** The address must be HTTPS, a bare origin, and carry no credentials. */
export function assertRemoteUrl(value) {
  let url;
  try { url = new URL(String(value)); } catch { throw new RemoteAccessError("INVALID_URL", "Enter the full HTTPS address, like https://atlas.example.com."); }
  if (url.protocol !== "https:") throw new RemoteAccessError("INVALID_URL", "Remote access must use HTTPS so tokens are never sent in clear text.");
  if (url.username || url.password) throw new RemoteAccessError("INVALID_URL", "The address must not contain a user name or password.");
  if (url.pathname !== "/" || url.search || url.hash) throw new RemoteAccessError("INVALID_URL", "Use the address of the site root, without a path.");
  return url.origin;
}

export function proxyGuides({ port, hostname = "atlas.example.com" }) {
  return {
    caddy: `${hostname} {\n\treverse_proxy 127.0.0.1:${port}\n}\n`,
    nginx: `server {\n  listen 443 ssl;\n  server_name ${hostname};\n  ssl_certificate     /etc/ssl/${hostname}/fullchain.pem;\n  ssl_certificate_key /etc/ssl/${hostname}/privkey.pem;\n  location / {\n    proxy_pass http://127.0.0.1:${port};\n    proxy_http_version 1.1;\n    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;\n    proxy_set_header Connection "";\n    proxy_buffering off;\n  }\n}\n`,
    tailscale: `tailscale serve --bg --https=443 http://127.0.0.1:${port}`,
  };
}

export class RemoteAccess {
  /**
   * @param {{ port: number, settingsPath: string, runCommandImpl?: typeof runCommand, fetchImpl?: typeof fetch }} options
   */
  constructor({ port, settingsPath, runCommandImpl = runCommand, fetchImpl = fetch }) {
    this.port = port;
    this.settingsPath = settingsPath;
    this.run = runCommandImpl;
    this.fetch = fetchImpl;
  }

  settings() {
    if (!existsSync(this.settingsPath)) return { mode: "off", url: null, ownerRemote: false };
    try {
      const value = JSON.parse(readFileSync(this.settingsPath, "utf8"));
      return { mode: ["tailscale", "proxy"].includes(value.mode) ? value.mode : "off", url: typeof value.url === "string" ? value.url : null, ownerRemote: value.ownerRemote === true };
    } catch {
      return { mode: "off", url: null, ownerRemote: false };
    }
  }

  #save(next) {
    const value = { ...this.settings(), ...next, updatedAt: new Date().toISOString() };
    mkdirSync(dirname(this.settingsPath), { recursive: true });
    writeFileSync(`${this.settingsPath}.tmp`, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    renameSync(`${this.settingsPath}.tmp`, this.settingsPath);
    return this.settings();
  }

  /** Whether the owner token may be used on a remote request. */
  ownerAllowedRemotely() {
    return this.settings().ownerRemote;
  }

  async tailscale() {
    const status = await this.run("tailscale", ["status", "--json"], { timeoutMs: 8_000 });
    if (!status.ok && !status.stdout) {
      const missing = /ENOENT|not found|not recognized/iu.test(status.stderr ?? "");
      return { installed: !missing, running: false, message: missing ? "Tailscale is not installed." : String(status.stderr ?? "").trim().slice(0, 300) || "Tailscale is not running." };
    }
    let parsed = {};
    try { parsed = JSON.parse(status.stdout); } catch { return { installed: true, running: false, message: "Tailscale did not report its status." }; }
    const dnsName = String(parsed.Self?.DNSName ?? "").replace(/\.$/u, "") || null;
    const running = parsed.BackendState === "Running";
    let serving = false;
    if (running) {
      const serve = await this.run("tailscale", ["serve", "status", "--json"], { timeoutMs: 8_000 });
      serving = serve.ok && new RegExp(`(127\\.0\\.0\\.1|localhost):${this.port}\\b`, "u").test(serve.stdout ?? "");
    }
    return {
      installed: true,
      running,
      dnsName,
      addresses: Array.isArray(parsed.Self?.TailscaleIPs) ? parsed.Self.TailscaleIPs : [],
      serving,
      url: serving && dnsName ? `https://${dnsName}` : null,
      message: running ? null : `Tailscale is ${String(parsed.BackendState ?? "stopped").toLowerCase()}; sign in to your tailnet first.`,
    };
  }

  async status() {
    const settings = this.settings();
    const tailscale = await this.tailscale();
    return {
      listening: `127.0.0.1:${this.port}`,
      settings,
      tailscale,
      guides: proxyGuides({ port: this.port, hostname: settings.mode === "proxy" && settings.url ? new URL(settings.url).hostname : undefined }),
    };
  }

  async enableTailscale() {
    const before = await this.tailscale();
    if (!before.installed) throw new RemoteAccessError("NO_TAILSCALE", "Install Tailscale (or a Headscale-compatible client), sign in on this computer and on your phone, then try again.");
    if (!before.running) throw new RemoteAccessError("TAILSCALE_STOPPED", before.message ?? "Tailscale is not running.");
    const result = await this.run("tailscale", ["serve", "--bg", "--https=443", `http://127.0.0.1:${this.port}`], { timeoutMs: 30_000 });
    if (!result.ok) {
      throw new RemoteAccessError("TAILSCALE_REFUSED", `Tailscale refused: ${String(result.stderr || result.stdout).trim().slice(0, 300)}. Run this yourself (with admin rights if asked): ${proxyGuides({ port: this.port }).tailscale}`);
    }
    const after = await this.tailscale();
    this.#save({ mode: "tailscale", url: after.url ?? (after.dnsName ? `https://${after.dnsName}` : null) });
    return this.status();
  }

  async disable() {
    const settings = this.settings();
    if (settings.mode === "tailscale") await this.run("tailscale", ["serve", "--https=443", "off"], { timeoutMs: 15_000 });
    this.#save({ mode: "off", url: null, ownerRemote: false });
    return this.status();
  }

  /** Records the HTTPS address of the owner's own proxy and checks that it reaches this Atlas. */
  async useProxy(value) {
    const url = assertRemoteUrl(value);
    let reachable = null;
    try {
      const response = await this.fetch(`${url}/health`, { signal: AbortSignal.timeout(5_000) });
      reachable = response.ok && (await response.json().catch(() => ({}))).mode === "sovereign";
    } catch {
      reachable = false;
    }
    this.#save({ mode: "proxy", url });
    return { ...(await this.status()), check: { reachable, message: reachable ? "The address reaches this Atlas." : "This computer could not reach that address. It may still work from your phone (some routers do not loop back); otherwise check the proxy." } };
  }

  setOwnerRemote(allow) {
    if (allow && this.settings().mode === "off") throw new RemoteAccessError("REMOTE_OFF", "Turn on remote access first.");
    return this.#save({ ownerRemote: Boolean(allow) });
  }
}

const STATUS = { INVALID_URL: 400, NO_TAILSCALE: 409, TAILSCALE_STOPPED: 409, TAILSCALE_REFUSED: 502, REMOTE_OFF: 409 };

/** /v1/remote — owner only: it reveals network details. Pairing codes come from /v1/pair. */
export function createRemoteRoutes({ remote, parseBody, send }) {
  return async function handle(request, response, identity) {
    const url = new URL(request.url ?? "/", "http://local.atlas");
    if (!url.pathname.startsWith("/v1/remote")) return false;
    if (identity.role !== "admin") return send(response, 403, { message: "Owner access required.", unblock: "Use the local owner token." });
    try {
      if (request.method === "GET" && url.pathname === "/v1/remote") return send(response, 200, await remote.status());
      if (request.method !== "POST") return send(response, 405, { message: "Method not allowed." });
      const body = await parseBody(request, response); if (!body) return true;
      if (url.pathname === "/v1/remote/tailscale") return send(response, 200, body.action === "disable" ? await remote.disable() : await remote.enableTailscale());
      if (url.pathname === "/v1/remote/proxy") return send(response, 200, await remote.useProxy(body.url));
      if (url.pathname === "/v1/remote/off") return send(response, 200, await remote.disable());
      if (url.pathname === "/v1/remote/owner") return send(response, 200, { settings: remote.setOwnerRemote(body.allow === true) });
      return send(response, 404, { message: "Route not found." });
    } catch (error) {
      if (error instanceof RemoteAccessError) return send(response, STATUS[error.code] ?? 400, { code: error.code, message: error.message });
      return send(response, 500, { message: error instanceof Error ? error.message : "The request failed." });
    }
  };
}
