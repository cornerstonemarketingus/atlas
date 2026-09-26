import { createServer, request as httpRequest } from "node:http";
import { connect } from "node:net";
import { createGuardedLookup, explicitlyPrivateHosts, PRIVATE_DESTINATION } from "./address-guard.mjs";

/**
 * Per-session egress proxy: the network-destination limit.
 *
 * Route interception (`context.route`) sees the first request of a
 * navigation but not the hops of an HTTP redirect chain, so a redirect from
 * an allowed origin to a disallowed one would still reach the disallowed
 * server. Every browser context is therefore pointed at this proxy (with
 * loopback included), and each request, redirect hop, CONNECT tunnel and
 * upgrade is checked here against the session's allow-list before any byte
 * is sent to the destination.
 */

const HOP_HEADERS = ["proxy-connection", "proxy-authorization", "proxy-authenticate"];

function stripBrackets(host) {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

function defaultPort(protocol) {
  return protocol === "https:" ? "443" : "80";
}

/**
 * @param {object} options
 * @param {Set<string>} options.allowedOrigins normalized http(s) origins
 * @param {(url: string, kind: string) => void} [options.onBlocked]
 * @param {boolean} [options.allowPrivateNetwork=false] let allowed hostnames resolve to private addresses
 * @param {Function} [options.lookup] dns.lookup-compatible resolver (tests)
 * @param {string} [options.allowPrivateHosts] comma-separated hostnames (default env ATLAS_BROWSER_ALLOW_PRIVATE_HOSTS)
 *
 * Every upstream socket resolves through ./address-guard.mjs, which refuses
 * private answers at connect time (DNS rebinding) unless the private host was
 * named explicitly.
 */
export async function startEgressProxy({ allowedOrigins, onBlocked = () => {}, allowPrivateNetwork = false, lookup, allowPrivateHosts }) {
  const guardedLookup = createGuardedLookup({
    permittedHosts: explicitlyPrivateHosts(allowedOrigins, allowPrivateHosts ?? process.env.ATLAS_BROWSER_ALLOW_PRIVATE_HOSTS),
    allowPrivateNetwork,
    ...(lookup ? { lookup } : {}),
  });
  const allowedHostPorts = new Set([...allowedOrigins].map((origin) => {
    const url = new URL(origin);
    return `${stripBrackets(url.hostname)}:${url.port || defaultPort(url.protocol)}`;
  }));
  const sockets = new Set();

  const httpAllowed = (target) =>
    (target.protocol === "http:" || target.protocol === "https:") && allowedOrigins.has(target.origin);

  const server = createServer((req, res) => {
    let target;
    try {
      target = new URL(req.url);
    } catch {
      res.writeHead(400).end();
      return;
    }
    if (!httpAllowed(target)) {
      onBlocked(target.toString(), "proxy");
      res.writeHead(403, { "content-type": "text/plain" }).end("Blocked by Atlas origin policy");
      return;
    }
    const headers = { ...req.headers };
    for (const header of HOP_HEADERS) delete headers[header];
    const upstream = httpRequest({
      host: stripBrackets(target.hostname),
      port: target.port || 80,
      method: req.method,
      path: `${target.pathname}${target.search}`,
      headers,
      lookup: guardedLookup,
    }, (response) => {
      res.writeHead(response.statusCode ?? 502, response.headers);
      response.pipe(res);
    });
    upstream.on("error", (error) => {
      if (error?.code === PRIVATE_DESTINATION) {
        onBlocked(target.toString(), "proxy-address");
        if (!res.headersSent) res.writeHead(403, { "content-type": "text/plain" }).end("Blocked by Atlas address policy");
        else res.destroy();
        return;
      }
      if (!res.headersSent) res.writeHead(502).end();
      else res.destroy();
    });
    req.pipe(upstream);
  });

  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  server.on("connect", (req, clientSocket, head) => {
    const match = /^\[?([^\]]+?)\]?:(\d+)$/.exec(req.url ?? "");
    if (!match || !allowedHostPorts.has(`${match[1]}:${match[2]}`)) {
      onBlocked(`connect://${req.url}`, "proxy-connect");
      clientSocket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    const upstream = connect({ port: Number(match[2]), host: match[1], lookup: guardedLookup }, () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head?.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    sockets.add(upstream);
    upstream.on("close", () => sockets.delete(upstream));
    upstream.on("error", (error) => {
      if (error?.code === PRIVATE_DESTINATION) {
        onBlocked(`connect://${req.url}`, "proxy-address");
        clientSocket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
        return;
      }
      clientSocket.destroy();
    });
    clientSocket.on("error", () => upstream.destroy());
  });

  server.on("upgrade", (req, clientSocket, head) => {
    let target;
    try {
      target = new URL(req.url);
    } catch {
      clientSocket.destroy();
      return;
    }
    const judged = new URL(target);
    if (judged.protocol === "ws:") judged.protocol = "http:";
    if (judged.protocol === "wss:") judged.protocol = "https:";
    if (!httpAllowed(judged)) {
      onBlocked(target.toString(), "proxy-upgrade");
      clientSocket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    const upstream = connect({ port: Number(target.port || 80), host: stripBrackets(target.hostname), lookup: guardedLookup }, () => {
      const lines = [`${req.method} ${target.pathname}${target.search} HTTP/1.1`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        if (!HOP_HEADERS.includes(req.rawHeaders[i].toLowerCase())) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
      }
      upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
      if (head?.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    sockets.add(upstream);
    upstream.on("close", () => sockets.delete(upstream));
    upstream.on("error", () => clientSocket.destroy());
    clientSocket.on("error", () => upstream.destroy());
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  return {
    server: `http://127.0.0.1:${port}`,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
