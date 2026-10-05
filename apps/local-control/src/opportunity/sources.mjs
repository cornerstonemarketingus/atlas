import { allowHostsFrom, assertPublicUrl } from "../../../windows-companion/src/url-safety.mjs";

/**
 * Where discovery reads from: a web search and public pages.
 *
 * Both are injected into the scout, so a site adapter (a job board's own API,
 * a browser session for a page that needs scripts) joins by implementing the
 * same two functions. Page text is untrusted and is bounded before it goes
 * anywhere; every address, including each redirect hop, must be public.
 */

const SEARCH_TIMEOUT_MS = 20_000;
const PAGE_TIMEOUT_MS = 15_000;
const MAX_PAGE_BYTES = 1_500_000;
const MAX_PAGE_TEXT = 8_000;
const MAX_REDIRECTS = 3;

export class SourceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "SourceError";
    this.code = code;
  }
}

/** The search key already used by hosted chat; absent means discovery says so plainly. */
export function searchKeyFrom(environment = process.env) {
  return (environment.ATLAS_TAVILY_API_KEY || environment.TAVILY_API_KEY || "").trim() || null;
}

/** @returns {(query: string, options?: { signal?: AbortSignal }) => Promise<{ title: string, url: string, snippet: string }[]>} */
export function createTavilySearch({ apiKey, fetchImpl = fetch } = {}) {
  if (!apiKey) throw new SourceError("NO_SEARCH", "Web search is not set up: add ATLAS_TAVILY_API_KEY to Atlas's environment.");
  return async function search(query, { signal } = {}) {
    const text = String(query ?? "").trim().slice(0, 400);
    if (!text) return [];
    const response = await fetchImpl("https://api.tavily.com/search", {
      method: "POST",
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(SEARCH_TIMEOUT_MS)]) : AbortSignal.timeout(SEARCH_TIMEOUT_MS),
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ query: text, max_results: 8, search_depth: "basic", include_answer: false }),
    });
    if (!response.ok) throw new SourceError("SEARCH_FAILED", `The search service answered ${response.status}.`);
    const body = await response.json();
    return (Array.isArray(body?.results) ? body.results : []).slice(0, 8)
      .map((result) => ({ title: String(result?.title ?? "").slice(0, 200), url: String(result?.url ?? ""), snippet: String(result?.content ?? "").replace(/\s+/gu, " ").slice(0, 600) }))
      .filter((result) => result.url);
  };
}

/** Visible text of an HTML page, bounded. */
export function htmlToText(html) {
  return String(html)
    .replace(/<(script|style|noscript|svg|template)\b[\s\S]*?<\/\1>/giu, " ")
    .replace(/<!--[\s\S]*?-->/gu, " ")
    .replace(/<\/(p|div|li|tr|h[1-6]|section|article|br)\s*>|<br\s*\/?>/giu, "\n")
    .replace(/<[^>]+>/gu, " ")
    .replace(/&nbsp;/giu, " ").replace(/&amp;/giu, "&").replace(/&lt;/giu, "<").replace(/&gt;/giu, ">").replace(/&quot;/giu, '"').replace(/&#39;|&apos;/giu, "'")
    .replace(/[ \t\f\v]+/gu, " ").replace(/\n\s*\n+/gu, "\n").trim();
}

/** @returns {(url: string, options?: { signal?: AbortSignal }) => Promise<{ url: string, title: string, text: string }>} */
export function createPageReader({ fetchImpl = fetch, guard = (url) => assertPublicUrl(url, { allowHosts: allowHostsFrom(process.env.ATLAS_BROWSER_ALLOW_HOSTS) }) } = {}) {
  return async function readPage(url, { signal } = {}) {
    let current = String(url);
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      const parsed = new URL(current);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new SourceError("UNSUPPORTED_SCHEME", "Only http and https pages are read.");
      await guard(current);
      const response = await fetchImpl(current, {
        redirect: "manual",
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(PAGE_TIMEOUT_MS)]) : AbortSignal.timeout(PAGE_TIMEOUT_MS),
        headers: { accept: "text/html,text/plain;q=0.9", "user-agent": "AtlasOpportunityScout/1.0" },
      });
      if (response.status >= 300 && response.status < 400 && response.headers.get("location")) {
        current = new URL(response.headers.get("location"), current).toString();
        continue;
      }
      if (!response.ok) throw new SourceError("PAGE_FAILED", `The page answered ${response.status}.`);
      const type = response.headers.get("content-type") ?? "";
      if (!/text\/(html|plain)|application\/xhtml/iu.test(type)) throw new SourceError("UNSUPPORTED_CONTENT", "The page is not text.");
      const declared = Number(response.headers.get("content-length") ?? 0);
      if (declared > MAX_PAGE_BYTES) throw new SourceError("PAGE_TOO_LARGE", "The page is too large.");
      const raw = (await response.text()).slice(0, MAX_PAGE_BYTES);
      const title = /<title[^>]*>([\s\S]*?)<\/title>/iu.exec(raw)?.[1]?.replace(/\s+/gu, " ").trim().slice(0, 200) ?? "";
      return { url: current, title, text: (/html/iu.test(type) ? htmlToText(raw) : raw).slice(0, MAX_PAGE_TEXT) };
    }
    throw new SourceError("TOO_MANY_REDIRECTS", "The page redirected too many times.");
  };
}
