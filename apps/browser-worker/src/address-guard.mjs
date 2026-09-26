import { lookup as dnsLookup } from "node:dns";

/**
 * Connect-time address guard for the egress proxy.
 *
 * The proxy's origin allow-list is checked on the hostname, but a hostname is
 * only a name: an allowed `https://shop.example` whose DNS answer is (or
 * later rebinds to) 127.0.0.1, 10.x or 169.254.169.254 would still let the
 * page reach the worker's own network. This guard is handed to
 * `http.request` / `net.connect` as their `lookup`, so the address is checked
 * after resolution and the socket connects to exactly the address that was
 * checked — there is no second resolution for a rebinding server to answer.
 *
 * Private destinations are allowed only when the operator named them
 * explicitly: an allowed origin whose host is itself an IP literal or
 * `localhost` (the test fixtures use http://127.0.0.1:<port>), a host listed
 * in ATLAS_BROWSER_ALLOW_PRIVATE_HOSTS, or `allowPrivateNetwork: true`.
 *
 * The IP classification below is a copy of apps/local-control
 * src/net/ssrf-guard.mjs; keep them in step.
 */

export function parseIPv4(host) {
  if (typeof host !== "string" || host.length === 0) return null;
  let parts = host.split(".");
  if (parts[parts.length - 1] === "" && parts.length > 1) parts = parts.slice(0, -1);
  if (parts.length === 0 || parts.length > 4) return null;
  const numbers = [];
  for (const part of parts) {
    let value;
    if (/^0[xX][0-9a-fA-F]*$/u.test(part)) value = part.length === 2 ? 0 : Number.parseInt(part.slice(2), 16);
    else if (/^0[0-7]+$/u.test(part)) value = Number.parseInt(part.slice(1), 8);
    else if (/^(0|[1-9][0-9]*)$/u.test(part)) value = Number(part);
    else return null;
    if (!Number.isSafeInteger(value)) return null;
    numbers.push(value);
  }
  const last = numbers.pop();
  if (numbers.some((value) => value > 255)) return null;
  if (last >= 256 ** (4 - numbers.length)) return null;
  let address = last;
  numbers.forEach((value, index) => { address += value * 256 ** (3 - index); });
  return address >>> 0;
}

/** Parses an IPv6 literal (brackets and zone id tolerated) into 8 groups. */
export function parseIPv6(host) {
  if (typeof host !== "string") return null;
  let text = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  const zone = text.indexOf("%");
  if (zone >= 0) text = text.slice(0, zone);
  if (!text.includes(":") || !/^[0-9a-fA-F:.]+$/u.test(text)) return null;
  const lastColon = text.lastIndexOf(":");
  const trailing = text.slice(lastColon + 1);
  if (trailing.includes(".")) {
    // Rewrite a dotted IPv4 tail (::ffff:1.2.3.4) as two hex groups.
    if (!/^\d{1,3}(\.\d{1,3}){3}$/u.test(trailing)) return null;
    const octets = trailing.split(".").map(Number);
    if (octets.some((octet) => octet > 255)) return null;
    const hi = ((octets[0] << 8) | octets[1]).toString(16);
    const lo = ((octets[2] << 8) | octets[3]).toString(16);
    text = `${text.slice(0, lastColon + 1)}${hi}:${lo}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const toGroups = (part) => (part === "" ? [] : part.split(":"));
  const head = toGroups(halves[0]);
  const rest = halves.length === 2 ? toGroups(halves[1]) : [];
  for (const group of [...head, ...rest]) if (!/^[0-9a-fA-F]{1,4}$/u.test(group)) return null;
  const explicit = head.length + rest.length;
  if (halves.length === 1 && explicit !== 8) return null;
  if (halves.length === 2 && explicit > 7) return null;
  const zeros = halves.length === 2 ? new Array(8 - explicit).fill(0) : [];
  return [...head, ...zeros.map(String), ...rest].map((group) => Number.parseInt(group, 16));
}

const IPV4_BLOCKS = [
  ["0.0.0.0", 8, "this-network"],
  ["10.0.0.0", 8, "private (RFC 1918)"],
  ["100.64.0.0", 10, "carrier-grade NAT"],
  ["127.0.0.0", 8, "loopback"],
  ["169.254.0.0", 16, "link-local / cloud metadata"],
  ["172.16.0.0", 12, "private (RFC 1918)"],
  ["192.0.0.0", 24, "IETF protocol assignments"],
  ["192.0.2.0", 24, "documentation"],
  ["192.88.99.0", 24, "6to4 relay"],
  ["192.168.0.0", 16, "private (RFC 1918)"],
  ["198.18.0.0", 15, "benchmarking"],
  ["198.51.100.0", 24, "documentation"],
  ["203.0.113.0", 24, "documentation"],
  ["224.0.0.0", 4, "multicast"],
  ["240.0.0.0", 4, "reserved / broadcast"],
].map(([base, bits, reason]) => ({ base: parseIPv4(base), bits, reason }));

function inV4Block(address, base, bits) {
  if (bits === 0) return true;
  const mask = (0xffffffff << (32 - bits)) >>> 0;
  return ((address & mask) >>> 0) === ((base & mask) >>> 0);
}

function ipv4Reason(address) {
  for (const block of IPV4_BLOCKS) if (inV4Block(address, block.base, block.bits)) return block.reason;
  return null;
}

function ipv6Reason(groups) {
  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups;
  const embedded = ((g6 << 16) | g7) >>> 0;
  // ::/96 (IPv4-compatible, includes :: and ::1) and ::ffff:0:0/96 (mapped).
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && (g5 === 0 || g5 === 0xffff)) {
    if (g5 === 0 && g6 === 0 && g7 === 1) return "loopback";
    if (g5 === 0 && g6 === 0 && g7 === 0) return "unspecified";
    const reason = ipv4Reason(embedded);
    return reason ? `IPv4-mapped ${reason}` : (g5 === 0 ? "IPv4-compatible (deprecated)" : null);
  }
  // SIIT translated ::ffff:0:a.b.c.d
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0xffff && g5 === 0) return ipv4Reason(embedded) ? "IPv4-translated private" : null;
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    const reason = ipv4Reason(embedded);
    return reason ? `NAT64 ${reason}` : null;
  }
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 1) return "NAT64 local-use";
  if (g0 === 0x2002) {
    const reason = ipv4Reason(((g1 << 16) | g2) >>> 0);
    return reason ? `6to4 ${reason}` : null;
  }
  if (g0 === 0x2001 && g1 === 0) return "Teredo";
  if (g0 === 0x2001 && g1 === 0x0db8) return "documentation";
  if (g0 === 0x0100 && g1 === 0 && g2 === 0 && g3 === 0) return "discard-only";
  if ((g0 & 0xfe00) === 0xfc00) return "unique local (fc00::/7)";
  if ((g0 & 0xffc0) === 0xfe80) return "link-local (fe80::/10)";
  if ((g0 & 0xffc0) === 0xfec0) return "site-local (deprecated)";
  if ((g0 & 0xff00) === 0xff00) return "multicast";
  return null;
}

/**
 * Why an IP literal is not a public destination, or null if it is public.
 * Returns undefined when `ip` is not an IP literal at all.
 */
export function privateAddressReason(ip) {
  const v6 = parseIPv6(ip);
  if (v6) return ipv6Reason(v6);
  const v4 = parseIPv4(ip);
  if (v4 !== null) return ipv4Reason(v4);
  return undefined;
}

export const PRIVATE_DESTINATION = "ATLAS_PRIVATE_DESTINATION";

function normalizeHost(host) {
  let value = String(host ?? "").toLowerCase();
  if (value.startsWith("[") && value.endsWith("]")) value = value.slice(1, -1);
  while (value.endsWith(".")) value = value.slice(0, -1);
  return value;
}

/**
 * Hosts whose private addresses are allowed because the operator named them:
 * IP-literal and localhost origins from the allow-list, plus the
 * comma-separated hostnames in `extra` (ATLAS_BROWSER_ALLOW_PRIVATE_HOSTS).
 */
export function explicitlyPrivateHosts(allowedOrigins, extra = process.env.ATLAS_BROWSER_ALLOW_PRIVATE_HOSTS) {
  const hosts = new Set();
  for (const origin of allowedOrigins) {
    const host = normalizeHost(new URL(origin).hostname);
    if (privateAddressReason(host) !== undefined || host === "localhost" || host.endsWith(".localhost")) hosts.add(host);
  }
  for (const entry of String(extra ?? "").split(",")) {
    const host = normalizeHost(entry.trim());
    if (host) hosts.add(host);
  }
  return hosts;
}

function blockedError(hostname, address, reason) {
  const error = new Error(`Blocked by Atlas address policy: ${hostname} resolves to ${address} (${reason}).`);
  error.code = PRIVATE_DESTINATION;
  return error;
}

/**
 * A `dns.lookup`-compatible function that refuses private answers for hosts
 * not in `permittedHosts`. Every returned address is vetted, and with
 * `all: true` so is every address offered for happy-eyeballs fallback.
 */
export function createGuardedLookup({ permittedHosts = new Set(), allowPrivateNetwork = false, lookup = dnsLookup } = {}) {
  return function guardedLookup(hostname, options, callback) {
    if (typeof options === "function") { callback = options; options = {}; }
    const opts = typeof options === "number" ? { family: options } : { ...(options ?? {}) };
    const host = normalizeHost(hostname);
    const permitted = allowPrivateNetwork || permittedHosts.has(host);
    lookup(hostname, { ...opts, all: true }, (error, addresses) => {
      if (error) return callback(error);
      const list = (Array.isArray(addresses) ? addresses : [{ address: addresses, family: opts.family ?? 4 }]);
      if (list.length === 0) return callback(Object.assign(new Error(`No address for ${hostname}`), { code: "ENOTFOUND" }));
      if (!permitted) {
        for (const entry of list) {
          const reason = privateAddressReason(entry.address);
          if (reason === undefined || reason !== null) return callback(blockedError(hostname, entry.address, reason ?? "not an IP address"));
        }
      }
      if (opts.all) return callback(null, list);
      return callback(null, list[0].address, list[0].family);
    });
  };
}

/**
 * For destinations given as IP literals (no lookup happens): allowed only if
 * public or explicitly permitted.
 */
export function literalDestinationAllowed(host, { permittedHosts = new Set(), allowPrivateNetwork = false } = {}) {
  const normalized = normalizeHost(host);
  const reason = privateAddressReason(normalized);
  if (reason === undefined || reason === null) return true;
  return allowPrivateNetwork || permittedHosts.has(normalized);
}
