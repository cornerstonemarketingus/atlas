/**
 * Start-URL policy for hosted computer tasks.
 *
 * A task's start URL is opened by the companion on the user's own PC, inside
 * their network, so a URL naming loopback, the LAN or a cloud metadata
 * address is refused at intake.
 *
 * LIMITATION: this runs in a Cloudflare Worker, which has no DNS lookup API,
 * so only the literal host is checked: IP literals in every encoding the URL
 * parser accepts (decimal, octal, hex, shorthand, IPv4-mapped IPv6) and names
 * that always mean "local" (localhost, *.local, *.internal, single-label).
 * A public hostname that resolves to a private address is NOT caught here;
 * the executor must re-check after resolution (apps/local-control
 * src/net/ssrf-guard.mjs, apps/browser-worker src/address-guard.mjs).
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

function normalizeHostname(hostname) {
  let host = String(hostname ?? "").toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  while (host.endsWith(".")) host = host.slice(0, -1);
  return host;
}

/** Why a host is not a public destination (literal checks only), or null. */
export function literalHostReason(hostname) {
  const host = normalizeHostname(hostname);
  if (!host) return "empty host";
  const ipReason = privateAddressReason(host);
  if (ipReason !== undefined) return ipReason;
  if (host === "localhost" || host.endsWith(".localhost")) return "loopback name";
  if (host.endsWith(".local")) return "multicast DNS (.local)";
  if (host.endsWith(".internal") || host.endsWith(".home.arpa") || host.endsWith(".lan") || host.endsWith(".intranet")) return "internal name";
  if (!host.includes(".")) return "single-label (LAN) name";
  return null;
}

/**
 * Validates a user-supplied start URL. Returns `{ ok: true, url }` with the
 * normalized URL, or `{ ok: false, message }`.
 */
export function validateStartUrl(candidate) {
  let url;
  try {
    url = new URL(String(candidate).trim());
  } catch {
    return { ok: false, message: "Start URL must be an http or https address." };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return { ok: false, message: "Start URL must be an http or https address." };
  if (url.username || url.password) return { ok: false, message: "Start URL must not contain credentials." };
  const reason = literalHostReason(url.hostname);
  if (reason) return { ok: false, message: `Start URL must be a public address; ${url.hostname} is ${reason}.` };
  return { ok: true, url: url.toString() };
}
