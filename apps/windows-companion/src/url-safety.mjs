import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * Where an agent-driven browser may go.
 *
 * A URL a model produces, or one a web page links to, is untrusted. Without a
 * check, "open http://169.254.169.254/latest/meta-data" reads cloud
 * credentials, and "open http://127.0.0.1:4317/v1/..." talks to Atlas's own
 * control plane with the browser's cookies (SECURITY-REVIEW SEC-3). This
 * module decides by resolved address, not by how the hostname is spelled, so
 * "localtest.me", decimal IPs and IPv4-mapped IPv6 are caught too.
 */

export class UrlSafetyError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "UrlSafetyError";
    this.code = code;
  }
}

const LOCAL_NAMES = /(^|\.)(localhost|local|internal|intranet|lan|home\.arpa|corp)$/iu;

function ipv4ToInt(address) {
  return address.split(".").reduce((value, part) => (value << 8) + Number(part), 0) >>> 0;
}

const V4_BLOCKS = [
  ["0.0.0.0", 8, "this network"],
  ["10.0.0.0", 8, "private network"],
  ["100.64.0.0", 10, "carrier-grade NAT"],
  ["127.0.0.0", 8, "loopback"],
  ["169.254.0.0", 16, "link-local / cloud metadata"],
  ["172.16.0.0", 12, "private network"],
  ["192.0.0.0", 24, "IETF protocol assignments"],
  ["192.168.0.0", 16, "private network"],
  ["198.18.0.0", 15, "benchmarking"],
  ["224.0.0.0", 4, "multicast"],
  ["240.0.0.0", 4, "reserved"],
].map(([base, bits, label]) => ({ base: ipv4ToInt(base), mask: bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0, label }));

/** Returns why an IP literal is not public, or null when it is. */
export function nonPublicReason(address) {
  const family = isIP(address);
  if (family === 4) {
    const value = ipv4ToInt(address);
    return V4_BLOCKS.find((block) => ((value & block.mask) >>> 0) === block.base)?.label ?? null;
  }
  if (family === 6) {
    const lower = address.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/u.exec(lower);
    if (mapped) return nonPublicReason(mapped[1]);
    if (lower === "::" || lower === "::1") return "loopback";
    if (/^f[cd]/u.test(lower)) return "private network";
    if (/^fe[89ab]/u.test(lower)) return "link-local";
    if (/^ff/u.test(lower)) return "multicast";
    return null;
  }
  return "not an IP address";
}

/**
 * Classifies a URL for agent navigation.
 * @returns {Promise<{ url: string, public: boolean, reason: string|null, addresses: string[] }>}
 * @throws UrlSafetyError for anything that is not a well-formed http(s) URL
 */
export async function classifyUrl(candidate, { resolve = (host) => lookup(host, { all: true, verbatim: true }), allowHosts = [] } = {}) {
  let url;
  try { url = new URL(candidate); } catch { throw new UrlSafetyError("INVALID_URL", "That is not a valid absolute URL."); }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new UrlSafetyError("UNSUPPORTED_SCHEME", `Atlas only opens http and https URLs, not '${url.protocol}'.`);
  }
  if (url.username || url.password) throw new UrlSafetyError("CREDENTIALS_IN_URL", "URLs with embedded credentials are refused.");
  const host = url.hostname.replace(/^\[|\]$/gu, "");
  if (allowHosts.map((h) => h.toLowerCase()).includes(host.toLowerCase())) return { url: url.toString(), public: true, reason: null, addresses: [] };
  if (isIP(host)) {
    const reason = nonPublicReason(host);
    return { url: url.toString(), public: !reason, reason, addresses: [host] };
  }
  if (LOCAL_NAMES.test(host)) return { url: url.toString(), public: false, reason: "a local network name", addresses: [] };
  let addresses;
  try { addresses = (await resolve(host)).map((entry) => entry.address); }
  catch { throw new UrlSafetyError("UNRESOLVABLE_HOST", `The host '${host}' could not be resolved.`); }
  // Every address must be public: one private answer is enough for a rebinding attack to pick it.
  const reason = addresses.map(nonPublicReason).find(Boolean) ?? null;
  return { url: url.toString(), public: !reason, reason, addresses };
}

/** Throws unless the URL is public (or explicitly allowed). */
export async function assertPublicUrl(candidate, options = {}) {
  const result = await classifyUrl(candidate, options);
  if (!result.public) {
    throw new UrlSafetyError("PRIVATE_ADDRESS", `Refusing to open ${new URL(result.url).host}: it points at ${result.reason}. Add it to ATLAS_BROWSER_ALLOW_HOSTS if this is intended.`);
  }
  return result.url;
}

/** Host allowlist from a comma-separated environment variable. */
export function allowHostsFrom(value = "") {
  return String(value).split(",").map((h) => h.trim()).filter(Boolean);
}
