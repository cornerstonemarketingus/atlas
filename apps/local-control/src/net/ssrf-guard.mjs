import { lookup as dnsLookup } from "node:dns/promises";

/**
 * Destination policy for URLs a model, a page, or a remote caller produced.
 *
 * A browser that Atlas drives runs on the operator's machine, inside the
 * operator's network. Letting an untrusted URL reach loopback (this daemon on
 * :4317), the LAN, or a cloud metadata endpoint turns the browser into a
 * request forger for everything the machine can reach. So a destination must
 * be public unless the operator explicitly allow-lists it.
 *
 * Checks, in order:
 *   1. literal host: IP literals in any encoding the WHATWG URL parser accepts
 *      (decimal, octal, hex, shorthand, IPv4-mapped IPv6) and well-known local
 *      names (`localhost`, `*.localhost`, `*.local`, `*.internal`, single-label);
 *   2. resolution: every address the hostname resolves to (not just the first)
 *      must be public. A resolver failure is a refusal: if we cannot see where
 *      a name points, we cannot say it is safe.
 *
 * Residual risk: the browser resolves the name again when it connects, so a
 * rebinding DNS server can still answer differently the second time. The
 * browser worker's egress proxy closes that gap by pinning the connect-time
 * address; Playwright sessions here re-check each request's host instead.
 */

export class UnsafeDestinationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "UnsafeDestinationError";
    this.code = code;
  }
}

export const ALLOW_PRIVATE_HOSTS_ENV = "ATLAS_BROWSER_ALLOW_PRIVATE_HOSTS";

/**
 * WHATWG-style IPv4 parse: 1–4 dot-separated parts, each decimal, `0x` hex or
 * leading-zero octal; the last part fills the remaining bytes. Returns the
 * address as an unsigned 32-bit number, or null if `host` is not IPv4.
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

export function isPrivateAddress(ip) {
  const reason = privateAddressReason(ip);
  return reason !== null && reason !== undefined;
}

function normalizeHostname(hostname) {
  let host = String(hostname ?? "").toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  while (host.endsWith(".")) host = host.slice(0, -1);
  return host;
}

/**
 * Checks that need no network: IP literals and names that always mean "this
 * machine or this network". Returns a reason string, or null.
 */
export function literalHostReason(hostname) {
  const host = normalizeHostname(hostname);
  if (!host) return "empty host";
  const ipReason = privateAddressReason(host);
  if (ipReason !== undefined) return ipReason;
  if (host === "localhost" || host.endsWith(".localhost")) return "loopback name";
  if (host.endsWith(".local")) return "multicast DNS (.local)";
  if (host.endsWith(".internal") || host.endsWith(".home.arpa") || host.endsWith(".lan") || host.endsWith(".intranet")) return "internal name";
  // A single-label name resolves through the local search domain: the LAN.
  if (!host.includes(".")) return "single-label (LAN) name";
  return null;
}

/**
 * Operator allow-list, e.g. "localhost,dev.example.test,*.corp.test,10.0.0.0/8,::1".
 * Entries are hostnames (exact, or `*.suffix`), IP literals, or CIDR ranges.
 */
export function parseAllowList(value) {
  const entries = (Array.isArray(value) ? value : String(value ?? "").split(","))
    .map((entry) => String(entry).trim().toLowerCase())
    .filter(Boolean);
  const names = new Set();
  const suffixes = [];
  const ranges = [];
  for (const entry of entries) {
    if (entry === "*") { ranges.push({ all: true }); names.add("*"); continue; }
    if (entry.startsWith("*.")) { suffixes.push(entry.slice(1)); continue; }
    const slash = entry.lastIndexOf("/");
    if (slash > 0) {
      const bits = Number(entry.slice(slash + 1));
      const base = entry.slice(0, slash);
      const v4 = parseIPv4(base);
      const v6 = parseIPv6(base);
      if (v4 !== null && Number.isInteger(bits) && bits >= 0 && bits <= 32) ranges.push({ v4, bits });
      else if (v6 && Number.isInteger(bits) && bits >= 0 && bits <= 128) ranges.push({ v6, bits });
      continue;
    }
    names.add(normalizeHostname(entry));
  }
  const addressMatches = (ip) => {
    const v4 = parseIPv4(ip);
    const v6 = v4 === null ? parseIPv6(ip) : null;
    for (const range of ranges) {
      if (range.all) return true;
      if (range.v4 !== undefined && v4 !== null && inV4Block(v4, range.v4, range.bits)) return true;
      if (range.v6 && v6 && v6InRange(v6, range.v6, range.bits)) return true;
    }
    if (names.has(normalizeHostname(ip))) return true;
    if (v6) {
      for (const name of names) {
        const other = parseIPv6(name);
        if (other && other.every((group, index) => group === v6[index])) return true;
      }
    }
    return false;
  };
  return {
    empty: entries.length === 0,
    hostAllowed(hostname) {
      const host = normalizeHostname(hostname);
      if (names.has("*") || names.has(host)) return true;
      if (suffixes.some((suffix) => host.endsWith(suffix))) return true;
      return privateAddressReason(host) !== undefined && addressMatches(host);
    },
    addressAllowed: addressMatches,
  };
}

function v6InRange(groups, base, bits) {
  let remaining = bits;
  for (let index = 0; index < 8 && remaining > 0; index += 1) {
    const take = Math.min(16, remaining);
    const mask = (0xffff << (16 - take)) & 0xffff;
    if ((groups[index] & mask) !== (base[index] & mask)) return false;
    remaining -= take;
  }
  return true;
}

/**
 * Resolves and vets a URL's destination. Returns `{ url, addresses }` or
 * throws UnsafeDestinationError. `lookup(hostname)` must resolve to an array
 * of `{ address, family }` (the shape of `dns.lookup(host, { all: true })`).
 */
export async function assertPublicDestination(candidate, {
  lookup = (hostname) => dnsLookup(hostname, { all: true, verbatim: true }),
  allowPrivateHosts = process.env[ALLOW_PRIVATE_HOSTS_ENV],
} = {}) {
  let url;
  try {
    url = candidate instanceof URL ? candidate : new URL(candidate);
  } catch {
    throw new UnsafeDestinationError("INVALID_URL", "That is not a valid absolute URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new UnsafeDestinationError("UNSUPPORTED_SCHEME", `Only http and https destinations are allowed, not '${url.protocol}'.`);
  }
  const allow = allowPrivateHosts && typeof allowPrivateHosts === "object" && "hostAllowed" in allowPrivateHosts
    ? allowPrivateHosts
    : parseAllowList(allowPrivateHosts);
  const host = normalizeHostname(url.hostname);
  if (allow.hostAllowed(host)) return { url: url.toString(), addresses: [], allowListed: true };

  const literal = literalHostReason(host);
  if (literal) {
    throw new UnsafeDestinationError("PRIVATE_DESTINATION", `Atlas does not open ${host} (${literal}). Add it to ${ALLOW_PRIVATE_HOSTS_ENV} to allow it deliberately.`);
  }
  if (privateAddressReason(host) !== undefined) return { url: url.toString(), addresses: [host], allowListed: false };

  let records;
  try {
    records = await lookup(host);
  } catch (error) {
    throw new UnsafeDestinationError("UNRESOLVABLE", `Atlas could not resolve ${host} (${error?.code ?? "lookup failed"}), so it cannot confirm the destination is public.`);
  }
  const addresses = (Array.isArray(records) ? records : [records]).map((record) => (typeof record === "string" ? record : record?.address)).filter(Boolean);
  if (addresses.length === 0) throw new UnsafeDestinationError("UNRESOLVABLE", `Atlas could not resolve ${host}.`);
  for (const address of addresses) {
    const reason = privateAddressReason(address);
    if (reason === undefined) throw new UnsafeDestinationError("UNRESOLVABLE", `${host} resolved to something that is not an IP address.`);
    if (reason && !allow.addressAllowed(address)) {
      throw new UnsafeDestinationError("PRIVATE_DESTINATION", `Atlas does not open ${host}: it resolves to ${address} (${reason}). Add it to ${ALLOW_PRIVATE_HOSTS_ENV} to allow it deliberately.`);
    }
  }
  return { url: url.toString(), addresses, allowListed: false };
}

/**
 * A cached per-host checker for high-volume use (every request a page makes).
 * Results are cached for `ttlMs`; refusals are cached too.
 */
export function createDestinationChecker({ lookup, allowPrivateHosts, ttlMs = 60_000, now = () => Date.now() } = {}) {
  const cache = new Map();
  const allow = parseAllowList(allowPrivateHosts ?? process.env[ALLOW_PRIVATE_HOSTS_ENV]);
  return async function check(candidate) {
    let url;
    try { url = new URL(candidate); } catch { return { ok: false, reason: "invalid URL" }; }
    if (url.protocol !== "http:" && url.protocol !== "https:") return { ok: true, skipped: true };
    const key = url.hostname;
    const cached = cache.get(key);
    if (cached && cached.expiresAt > now()) return cached.result;
    let result;
    try {
      await assertPublicDestination(url, { lookup, allowPrivateHosts: allow });
      result = { ok: true };
    } catch (error) {
      result = { ok: false, reason: error.message, code: error.code };
    }
    cache.set(key, { result, expiresAt: now() + ttlMs });
    if (cache.size > 1_000) cache.delete(cache.keys().next().value);
    return result;
  };
}
