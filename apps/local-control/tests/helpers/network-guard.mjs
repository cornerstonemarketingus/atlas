/**
 * Fails any outbound connection to a host that is not this machine.
 *
 * Every TCP and TLS connection in Node, including the built-in fetch,
 * goes through net.Socket.prototype.connect, so that is where the guard sits;
 * fetch and DNS lookups are wrapped as well so a refusal names the host
 * before any resolution. A blocked attempt throws and is recorded; when
 * ATLAS_NETWORK_GUARD_LOG names a file, every attempt is appended to it as a
 * JSON line ({ host, port, allowed, via }), so a test can inspect a child
 * process.
 *
 * Use in-process with installNetworkGuard(), or for a child process with
 * `node --import <this file>` and ATLAS_NETWORK_GUARD=1.
 */
import { appendFileSync } from "node:fs";
import dns from "node:dns";
import net from "node:net";

const LOOPBACK = (host) => {
  const value = String(host ?? "").toLowerCase().replace(/^\[|\]$/gu, "");
  return value === "localhost" || value === "::1" || value === "::ffff:127.0.0.1" || /^127(?:\.\d{1,3}){3}$/u.test(value);
};

export class BlockedConnectionError extends Error {
  constructor(host, port, via) {
    super(`NETWORK_GUARD: blocked a ${via} connection to ${host}${port ? `:${port}` : ""} (only loopback is allowed in local-only mode)`);
    this.name = "BlockedConnectionError";
    this.code = "NETWORK_GUARD_BLOCKED";
  }
}

export function installNetworkGuard({ logFile = process.env.ATLAS_NETWORK_GUARD_LOG || null } = {}) {
  const attempts = [];
  const record = (host, port, via) => {
    const entry = { host: String(host), port: port ?? null, allowed: LOOPBACK(host), via };
    attempts.push(entry);
    if (logFile) { try { appendFileSync(logFile, `${JSON.stringify(entry)}\n`); } catch { /* best effort */ } }
    if (!entry.allowed) throw new BlockedConnectionError(host, port, via);
  };

  const originalConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function guardedConnect(...args) {
    const first = Array.isArray(args[0]) ? args[0][0] : args[0];
    let host;
    let port;
    let path = null;
    if (first && typeof first === "object") { host = first.host ?? "localhost"; port = first.port; path = first.path ?? null; }
    else if (typeof first === "string" && !/^\d+$/u.test(first)) path = first;
    else { port = first; host = typeof args[1] === "string" ? args[1] : "localhost"; }
    // Unix sockets and named pipes never leave the machine.
    if (path === null) record(host, port, "tcp");
    return originalConnect.apply(this, args);
  };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = function guardedFetch(input, init) {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    // fetch reports failures as a rejected promise, never a synchronous throw.
    try { record(url.hostname, url.port || (url.protocol === "https:" ? 443 : 80), "fetch"); } catch (error) { return Promise.reject(error); }
    return originalFetch.call(this, input, init);
  };

  const originalLookup = dns.lookup;
  dns.lookup = function guardedLookup(hostname, ...rest) {
    if (!LOOPBACK(hostname) && net.isIP(hostname) === 0) {
      const callback = rest.at(-1);
      try { record(hostname, null, "dns"); } catch (error) { if (typeof callback === "function") { process.nextTick(callback, error); return {}; } throw error; }
    }
    return originalLookup.call(this, hostname, ...rest);
  };
  const originalPromiseLookup = dns.promises.lookup;
  dns.promises.lookup = async function guardedPromiseLookup(hostname, ...rest) {
    if (!LOOPBACK(hostname) && net.isIP(hostname) === 0) record(hostname, null, "dns");
    return originalPromiseLookup.call(this, hostname, ...rest);
  };

  return {
    attempts,
    blocked: () => attempts.filter((entry) => !entry.allowed),
    uninstall() {
      net.Socket.prototype.connect = originalConnect;
      globalThis.fetch = originalFetch;
      dns.lookup = originalLookup;
      dns.promises.lookup = originalPromiseLookup;
    },
  };
}

if (process.env.ATLAS_NETWORK_GUARD === "1") installNetworkGuard();
