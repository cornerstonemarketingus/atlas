/**
 * Preloaded into a daemon under test with `node --import`: every outbound TCP
 * connection the process opens is checked, and any to a host that is not
 * loopback is refused and appended to the file named by
 * ATLAS_LOOPBACK_GUARD_LOG (one JSON line per attempt). Unix sockets and named
 * pipes are local by definition and pass.
 *
 * This covers the daemon's own process. Child processes it spawns (the coder,
 * test commands, the browser) start with a filtered environment and are
 * checked separately: the fake model records every model call they make.
 */
import { appendFileSync } from "node:fs";
import net from "node:net";

const log = process.env.ATLAS_LOOPBACK_GUARD_LOG;
const LOOPBACK = /^(127\.\d{1,3}\.\d{1,3}\.\d{1,3}|::1|\[::1\]|localhost|::ffff:127\.\d{1,3}\.\d{1,3}\.\d{1,3})$/iu;

const original = net.Socket.prototype.connect;
net.Socket.prototype.connect = function guardedConnect(...args) {
  const first = args[0];
  let host;
  let port;
  let path;
  if (first && typeof first === "object" && !Array.isArray(first)) {
    ({ host, port, path } = first);
  } else if (typeof first === "string" && Number.isNaN(Number(first))) {
    path = first;
  } else {
    port = first;
    host = typeof args[1] === "string" ? args[1] : undefined;
  }
  if (path) return original.apply(this, args);
  const target = host ?? "localhost";
  if (!LOOPBACK.test(String(target))) {
    if (log) {
      try { appendFileSync(log, `${JSON.stringify({ host: target, port: port ?? null, at: new Date().toISOString() })}\n`); } catch { /* best effort */ }
    }
    const error = Object.assign(new Error(`Acceptance guard: refused a connection to non-loopback host ${target}:${port ?? "?"}.`), { code: "ECONNREFUSED" });
    process.nextTick(() => this.destroy(error));
    return this;
  }
  return original.apply(this, args);
};
