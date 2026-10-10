import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import { pathToFileURL } from "node:url";

const MAX_ENTRIES = 2_000;
const MAX_PAGES = 200;
const MAX_DEPTH = 8;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;

export class SeoAuditError extends Error {
  constructor(message) { super(message); this.name = "SeoAuditError"; }
}

function publicOrigin(value) {
  let url;
  try { url = new URL(value); } catch { throw new SeoAuditError("Use an absolute HTTPS production origin, such as https://example.com."); }
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new SeoAuditError("The production origin must use HTTPS without credentials, a path, query or fragment.");
  }
  return url.origin;
}

function decode(value) {
  return String(value).replace(/&(?:amp|quot|apos|lt|gt);/gu, (entity) => ({ "&amp;": "&", "&quot;": '"', "&apos;": "'", "&lt;": "<", "&gt;": ">" }[entity]));
}

function attributes(tag) {
  const result = {};
  for (const match of tag.matchAll(/([^\s=<>/]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>\x60]+))/gu)) {
    result[match[1].toLowerCase()] = decode(match[2] ?? match[3] ?? match[4]);
  }
  return result;
}

function absoluteUrl(value, origin) {
  let url;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== "https:" || url.origin !== origin || url.username || url.password || url.hash) return null;
  return url.href;
}

/**
 * Read-only audit of an already-built public static site. No crawling, model,
 * network, deployment, or automatic source edits. Supports a simple urlset
 * sitemap; full XML/HTML validation and server response headers are out of scope.
 */
export function auditBuiltSite({ directory, url }) {
  if (typeof directory !== "string" || !directory.trim()) throw new SeoAuditError("Select the built-site directory.");
  const origin = publicOrigin(url);
  const root = resolve(directory);
  let rootInfo;
  try { rootInfo = lstatSync(root); } catch { throw new SeoAuditError("The built-site directory does not exist or cannot be read."); }
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new SeoAuditError("The built-site path must be a directory, not a symbolic link.");
  const files = new Map();
  let entries = 0;
  let totalBytes = 0;
  function scan(folder, depth) {
    if (depth > MAX_DEPTH) throw new SeoAuditError("The site exceeds the audit directory-depth limit.");
    for (const entry of readdirSync(folder, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (++entries > MAX_ENTRIES) throw new SeoAuditError("The site exceeds the audit entry limit.");
      const path = join(folder, entry.name);
      const info = lstatSync(path);
      if (info.isSymbolicLink()) throw new SeoAuditError("The site contains a symbolic link; audit a contained build directory.");
      if (info.isDirectory()) { scan(path, depth + 1); continue; }
      const file = relative(root, path).split("\\").join("/");
      if (!info.isFile() || !(/\.html?$/iu.test(file) || file === "sitemap.xml" || file === "robots.txt")) continue;
      if (info.size > MAX_FILE_BYTES) throw new SeoAuditError("A site document exceeds the audit file-size limit.");
      totalBytes += info.size;
      if (totalBytes > MAX_TOTAL_BYTES) throw new SeoAuditError("The site exceeds the audit total document-size limit.");
      files.set(file, readFileSync(path, "utf8"));
    }
  }
  scan(root, 0);
  const pages = [...files.keys()].filter((file) => /\.html?$/iu.test(file));
  if (pages.length > MAX_PAGES) throw new SeoAuditError("The site exceeds the audit page limit.");
  const findings = [];
  const add = (severity, code, file, message) => findings.push({ severity, code, file, message });
  if (!pages.length) add("error", "NO_PAGES", ".", "No built HTML pages were found.");
  const titles = new Map();
  const canonicals = new Map();
  const pageCanonicals = [];

  for (const file of pages) {
    const html = files.get(file).replace(/<!--[\s\S]*?-->/gu, "").replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/giu, "");
    const head = html.match(/<head\b[^>]*>([\s\S]*?)<\/head\s*>/iu)?.[1] ?? "";
    const title = decode(head.match(/<title\b[^>]*>([^<]*)<\/title\s*>/iu)?.[1] ?? "").trim();
    if (!title) add("error", "TITLE_MISSING", file, "Add a nonempty page title.");
    else {
      if (titles.has(title)) add("warning", "TITLE_DUPLICATE", file, "Use a distinct title for each public page.");
      titles.set(title, file);
    }
    const meta = [...head.matchAll(/<meta\b[^>]*>/giu)].map((match) => attributes(match[0]));
    if (!meta.some((tag) => tag.name?.toLowerCase() === "description" && tag.content?.trim())) {
      add("warning", "DESCRIPTION_MISSING", file, "Add a descriptive meta description.");
    }
    // Google also respects robots metadata placed in the body.
    const robots = [...html.matchAll(/<meta\b[^>]*>/giu)].map((match) => attributes(match[0]));
    if (robots.some((tag) => ["robots", "googlebot"].includes(tag.name?.toLowerCase()) && /(?:^|[\s,])(?:noindex|none)(?:$|[\s,])/iu.test(tag.content ?? ""))) {
      add("error", "NOINDEX", file, "This page asks search engines not to index it; review before a public launch.");
    }
    if (!/<h1\b[^>]*>\s*[^<\s]/iu.test(html)) add("warning", "HEADING_REVIEW", file, "Check that the page has a meaningful primary heading.");
    const links = [...head.matchAll(/<link\b[^>]*>/giu)].map((match) => attributes(match[0]))
      .filter((tag) => tag.rel?.toLowerCase().split(/\s+/u).includes("canonical"));
    if (links.length !== 1) {
      add("error", "CANONICAL_COUNT", file, "Use exactly one canonical link in the HTML head.");
      continue;
    }
    const canonical = absoluteUrl(links[0].href, origin);
    if (!canonical) {
      add("error", "CANONICAL_INVALID", file, "Use an absolute HTTPS canonical on the selected production origin, without credentials or a fragment.");
      continue;
    }
    if (canonicals.has(canonical)) add("warning", "CANONICAL_SHARED", file, "Multiple built pages share this canonical; confirm the duplication is intentional.");
    canonicals.set(canonical, file);
    pageCanonicals.push({ file, canonical });
  }

  const sitemap = files.get("sitemap.xml");
  const listed = new Set();
  if (!sitemap) add("error", "SITEMAP_MISSING", "sitemap.xml", "Provide a root sitemap.xml for this launch audit.");
  else {
    const xml = sitemap.replace(/<!--[\s\S]*?-->/gu, "");
    if (!/<urlset\b/iu.test(xml)) add("error", "SITEMAP_FORMAT", "sitemap.xml", "This audit supports a urlset sitemap; sitemap indexes require a separate check.");
    const locations = [...xml.matchAll(/<loc\s*>([^<]*)<\/loc\s*>/giu)];
    if (!locations.length) add("error", "SITEMAP_EMPTY", "sitemap.xml", "The sitemap has no page locations.");
    for (const location of locations) {
      const canonical = absoluteUrl(decode(location[1].trim()), origin);
      if (!canonical) add("error", "SITEMAP_URL_INVALID", "sitemap.xml", "Every location must be absolute HTTPS on the selected production origin, without credentials or a fragment.");
      else {
        if (listed.has(canonical)) add("warning", "SITEMAP_DUPLICATE", "sitemap.xml", "The sitemap repeats a page location.");
        listed.add(canonical);
      }
    }
    for (const { file, canonical } of pageCanonicals) {
      if (!listed.has(canonical)) add("error", "SITEMAP_CANONICAL_MISSING", file, "The page's canonical is absent from the sitemap.");
    }
  }
  const robots = files.get("robots.txt");
  if (!robots) add("warning", "ROBOTS_MISSING", "robots.txt", "Consider a robots.txt file with an absolute sitemap location.");
  else {
    const clean = robots.split(/\r?\n/u).map((line) => line.replace(/#.*/u, "").trim());
    const references = clean.filter((line) => /^sitemap\s*:/iu.test(line)).map((line) => line.replace(/^sitemap\s*:\s*/iu, ""));
    if (!references.some((value) => absoluteUrl(value, origin) === origin + "/sitemap.xml")) {
      add("warning", "ROBOTS_SITEMAP", "robots.txt", "Reference the absolute production sitemap URL in robots.txt.");
    }
    if (clean.some((line) => /^disallow\s*:\s*\/\s*$/iu.test(line))) {
      add("warning", "ROBOTS_RULE_REVIEW", "robots.txt", "A crawler group disallows the root; review its user-agent and allow-rule precedence.");
    }
  }
  const errors = findings.filter((finding) => finding.severity === "error").length;
  const warnings = findings.length - errors;
  return { schemaVersion: 1, origin, status: errors ? "needs-work" : "passed", pages: pages.length, errors, warnings, findings,
    limitations: ["Static files only; HTTP headers, redirects, live crawling, search rankings and GEO visibility are not measured.", "Metadata extraction is bounded and conservative; this is not a complete HTML/XML or robots-rule parser."] };
}

export function main(args = process.argv.slice(2)) {
  if (args.length === 1 && args[0] === "--help") {
    process.stdout.write("Usage: node scripts/local/seo-audit.mjs --directory <built-site> --url https://example.com\nRead-only JSON launch audit. Exit codes: 0 passed, 1 findings, 2 invalid input or unreadable/oversized build.\n");
    return 0;
  }
  try {
    const options = {};
    for (let index = 0; index < args.length; index += 2) {
      const flag = args[index];
      if (!["--directory", "--url"].includes(flag) || options[flag] !== undefined || !args[index + 1] || args[index + 1].startsWith("--")) {
        throw new SeoAuditError("Provide --directory and --url once each. Use --help for usage.");
      }
      options[flag] = args[index + 1];
    }
    const report = auditBuiltSite({ directory: options["--directory"], url: options["--url"] });
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    return report.errors ? 1 : 0;
  } catch (error) {
    // Do not print raw filesystem errors or the contents of an untrusted page.
    process.stderr.write((error instanceof SeoAuditError ? error.message : "The built site could not be audited safely.") + "\n");
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = main();
