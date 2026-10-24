/**
 * Preloaded into a child CLI process (`node --import <compiled file>` with
 * ATLAS_NETWORK_GUARD=1): fails, and records as a JSON line in
 * ATLAS_NETWORK_GUARD_LOG, every outbound connection whose host is not this
 * machine. Every TCP and TLS connection in Node, the built-in fetch
 * included, goes through net.Socket.prototype.connect; fetch is wrapped too
 * so a refusal names the host before DNS. Test infrastructure only.
 */
import { appendFileSync } from "node:fs";
import net from "node:net";

const loopback = (host: string): boolean => {
  const value = host.toLowerCase().replace(/^\[|\]$/gu, "");
  return value === "localhost" || value === "::1" || /^127(?:\.\d{1,3}){3}$/u.test(value);
};

function record(host: string, port: unknown, via: string): void {
  const entry = { host, port: port ?? null, allowed: loopback(host), via };
  const log = process.env["ATLAS_NETWORK_GUARD_LOG"];
  if (log) appendFileSync(log, `${JSON.stringify(entry)}\n`);
  if (!entry.allowed) throw Object.assign(new Error(`NETWORK_GUARD: blocked a ${via} connection to ${host}`), { code: "NETWORK_GUARD_BLOCKED" });
}

if (process.env["ATLAS_NETWORK_GUARD"] === "1") {
  const originalConnect = net.Socket.prototype.connect as (...args: unknown[]) => net.Socket;
  (net.Socket.prototype as unknown as { connect: (...args: unknown[]) => net.Socket }).connect = function guardedConnect(this: net.Socket, ...args: unknown[]) {
    const first = Array.isArray(args[0]) ? (args[0] as unknown[])[0] : args[0];
    if (first !== null && typeof first === "object") {
      const options = first as { host?: string; port?: unknown; path?: string };
      if (options.path === undefined) record(options.host ?? "localhost", options.port, "tcp");
    } else if (typeof first === "number" || (typeof first === "string" && /^\d+$/u.test(first))) {
      record(typeof args[1] === "string" ? args[1] : "localhost", first, "tcp");
    }
    return originalConnect.apply(this, args);
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    try { record(url.hostname, url.port || (url.protocol === "https:" ? 443 : 80), "fetch"); } catch (error) { return Promise.reject(error); }
    return originalFetch(input, init);
  };
}
