import { observedGitHubFetch } from "../tasks/github-observability.mjs";
import { repositoryContentCache } from "./repository-content-cache.mjs";

/**
 * Tools Atlas uses inside a chat reply, before it answers.
 *
 * `start_atlas_task` starts long work (a GitHub run, a computer task) and
 * reports back later. These are the opposite: quick, read-only lookups the
 * model can chain within one reply, the way a coding agent reads a file or a
 * page before it answers:
 *
 * - read_web_page: fetch one public https page as text.
 * - web_search: search the web (only offered when a search key is set).
 * - read_repository_file: read a file or list a directory in a repository on
 *   the workspace's allowlist.
 * - search_repository_code: find where something is in such a repository.
 *
 * Everything these return is untrusted data. It goes back to the model in a
 * `<data source="…">` block that the content cannot close, and nothing here
 * can change anything anywhere.
 */

export const INSTANT_TOOL_NAMES = Object.freeze(["read_web_page", "web_search", "read_repository_file", "search_repository_code"]);

const MAX_PAGE_BYTES = 600_000;
const MAX_TOOL_CHARS = 7_000;
const MAX_FILE_CHARS = 4_000;
const DEFAULT_FILE_CHARS = 3_000;
const TOOL_TIMEOUT_MS = 12_000;
const REPOSITORY_PATTERN = /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/u;

const definition = (name, description, properties, required) => ({
  type: "function",
  function: { name, description, parameters: { type: "object", properties, required, additionalProperties: false } },
});

const READ_WEB_PAGE = definition(
  "read_web_page",
  "Fetch one public web page (https) and read its text. Use it when the person shares a link or when an answer depends on a specific page. Read-only.",
  { url: { type: "string", description: "The full https URL." } },
  ["url"],
);
const WEB_SEARCH = definition(
  "web_search",
  "Search the web for current information (news, documentation, prices, releases). Returns titles, links and snippets; read a result with read_web_page when the snippet is not enough.",
  { query: { type: "string", description: "What to search for." } },
  ["query"],
);
const READ_REPOSITORY_FILE = definition(
  "read_repository_file",
  "Read a file, or list a directory, in a GitHub repository connected to this workspace (including your own, cornerstonemarketingus/atlas). Returns a small page; follow nextOffset with fileSha to read omitted sections before making claims about them. Read-only.",
  {
    repository: { type: "string", description: "owner/name" },
    path: { type: "string", description: "Path inside the repository; empty or \"/\" for the root directory." },
    ref: { type: "string", description: "Branch, tag or commit. Defaults to the default branch." },
    offset: { type: "integer", minimum: 0, description: "Character offset from nextOffset in the previous page. Defaults to 0." },
    maxChars: { type: "integer", minimum: 256, maximum: MAX_FILE_CHARS, description: "Page size; defaults to 3000 characters." },
    fileSha: { type: "string", description: "File SHA from the previous page; required when offset is not 0, so changed files cannot be mixed." },
  },
  ["repository", "path"],
);
const SEARCH_REPOSITORY_CODE = definition(
  "search_repository_code",
  "Search the code of a GitHub repository connected to this workspace and get matching file paths. Use it to find where something is defined or used before reading the file.",
  {
    repository: { type: "string", description: "owner/name" },
    query: { type: "string", description: "Words or an identifier to find." },
  },
  ["repository", "query"],
);

/** The instant tools offered to the model; web search only when a search key is configured. */
export function instantToolDefinitions(environment = {}) {
  return [READ_WEB_PAGE, ...(searchKey(environment) ? [WEB_SEARCH] : []), READ_REPOSITORY_FILE, SEARCH_REPOSITORY_CODE];
}

export function isInstantTool(name) {
  return INSTANT_TOOL_NAMES.includes(name);
}

function searchKey(environment) {
  const key = environment?.ATLAS_TAVILY_API_KEY ?? environment?.TAVILY_API_KEY;
  return typeof key === "string" && key.trim() ? key.trim() : "";
}

/** Wraps untrusted text so the model can tell where it came from and the text cannot close the block. */
export function asData(source, text) {
  const label = String(source).replace(/[^A-Za-z0-9._:/ #?=&-]/gu, "").slice(0, 160) || "tool";
  const body = String(text ?? "").replace(/<(\s*\/?\s*)data\b/giu, "&lt;$1data");
  return `<data source="${label}">\n${body}\n</data>`;
}

function clip(text, max) {
  return text.length > max ? `${text.slice(0, max)}\n… (truncated, ${text.length - max} more characters)` : text;
}

/**
 * Public pages only: https, a DNS name (no IP literals), and not a name that
 * points inside a private network. The Worker cannot reach private networks
 * anyway; this keeps the intent explicit and testable.
 */
export function publicPageUrl(raw) {
  let url;
  try { url = new URL(String(raw ?? "").trim()); } catch { return null; }
  if (url.protocol !== "https:" || url.username || url.password) return null;
  const host = url.hostname.toLowerCase();
  if (!host.includes(".") || host.startsWith("[") || /^[\d.]+$/u.test(host)) return null;
  if (/(^|\.)(localhost|local|internal|intranet|lan|home|corp|localdomain)$/u.test(host)) return null;
  url.hash = "";
  return url;
}

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ", "#39": "'" };

/** HTML to readable text: drops scripts, styles and markup, keeps block breaks. */
export function htmlToText(html) {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/iu.exec(html)?.[1]?.trim() ?? "";
  const text = String(html)
    .replace(/<(script|style|noscript|svg|template|iframe)[\s\S]*?<\/\1\s*>/giu, " ")
    .replace(/<!--[\s\S]*?-->/gu, " ")
    .replace(/<\/?(p|div|section|article|header|footer|li|ul|ol|h[1-6]|br|tr|table|pre|blockquote)\b[^>]*>/giu, "\n")
    .replace(/<[^>]+>/gu, " ")
    .replace(/&(#\d+|#x[\da-f]+|[a-z]+);/giu, (match, entity) => {
      const lower = entity.toLowerCase();
      if (lower in ENTITIES) return ENTITIES[lower];
      if (lower.startsWith("#x")) return safeCodePoint(Number.parseInt(lower.slice(2), 16), match);
      if (lower.startsWith("#")) return safeCodePoint(Number.parseInt(lower.slice(1), 10), match);
      return match;
    })
    .replace(/[ \t\f\v\r]+/gu, " ")
    .replace(/ *\n[ \n]*/gu, "\n")
    .trim();
  return { title: htmlDecodeTitle(title), text };
}

function safeCodePoint(code, fallback) {
  return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : fallback;
}

function htmlDecodeTitle(title) {
  return title.replace(/\s+/gu, " ").replace(/&amp;/gu, "&").replace(/&#39;|&apos;/gu, "'").replace(/&quot;/gu, "\"");
}

async function readBounded(response, maxBytes) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
    if (total >= maxBytes) { await reader.cancel().catch(() => {}); break; }
  }
  const joined = new Uint8Array(Math.min(total, maxBytes));
  let offset = 0;
  for (const chunk of chunks) {
    const part = chunk.subarray(0, Math.min(chunk.byteLength, joined.byteLength - offset));
    joined.set(part, offset);
    offset += part.byteLength;
    if (offset >= joined.byteLength) break;
  }
  return new TextDecoder().decode(joined);
}

function parseArguments(call) {
  const raw = call?.function?.arguments;
  if (raw && typeof raw === "object") return raw;
  try { return JSON.parse(typeof raw === "string" && raw ? raw : "{}"); } catch { return null; }
}

/**
 * Runs one instant tool call. Never throws: failures come back as a short
 * message the model can read and recover from.
 *
 * @param {{ function?: { name?: string, arguments?: unknown } }} call
 * @param {{ fetcher?: typeof fetch, environment?: Record<string, string|undefined>, allowlist?: Set<string>, githubToken?: () => Promise<string|undefined> }} context
 * @returns {Promise<{ ok: boolean, label: string, content: string, preview?: { kind: "file" | "page", title: string, content: string, url?: string, repository?: string, path?: string } }>}
 */
export async function runInstantTool(call, context = {}) {
  const name = call?.function?.name ?? "";
  const args = parseArguments(call);
  if (!args) return { ok: false, label: `Could not read the ${name} request`, content: "The tool arguments were not valid JSON." };
  const fetcher = context.fetcher ?? fetch;
  try {
    if (name === "read_web_page") return await readWebPage(args, fetcher);
    if (name === "web_search") return await webSearch(args, fetcher, context.environment ?? {});
    if (name === "read_repository_file") return await readRepositoryFile(args, fetcher, context);
    if (name === "search_repository_code") return await searchRepositoryCode(args, fetcher, context);
    return { ok: false, label: `Unknown tool ${name}`, content: `There is no tool named '${name}'.` };
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    return { ok: false, label: `${name} failed`, content: timedOut ? "The request timed out." : "The request failed." };
  }
}

async function readWebPage(args, fetcher) {
  const url = publicPageUrl(args.url);
  if (!url) return { ok: false, label: "Refused a non-public link", content: "Only public https pages can be read." };
  const response = await fetcher(url.toString(), {
    redirect: "follow",
    signal: AbortSignal.timeout(TOOL_TIMEOUT_MS),
    headers: { accept: "text/html,text/plain,application/json;q=0.9,*/*;q=0.5", "user-agent": "AtlasBot/1.0 (+https://github.com/cornerstonemarketingus/atlas)" },
  });
  const finalUrl = publicPageUrl(response.url || url.toString());
  const shown = url.host + url.pathname;
  if (!finalUrl) return { ok: false, label: `Refused a redirect from ${shown}`, content: "The page redirected to a non-public address." };
  if (!response.ok) return { ok: false, label: `Could not read ${shown}`, content: `The site answered ${response.status}.` };
  const type = response.headers.get("content-type") ?? "";
  if (!/text\/|json|xml/iu.test(type)) return { ok: false, label: `Skipped ${shown}`, content: `The page is ${type || "an unknown type"}, not text.` };
  const raw = await readBounded(response, MAX_PAGE_BYTES);
  const { title, text } = /html/iu.test(type) ? htmlToText(raw) : { title: "", text: raw };
  const pageText = clip(`${title ? `${title}\n\n` : ""}${text}`, MAX_TOOL_CHARS);
  return {
    ok: true, label: `Read ${title ? `“${title.slice(0, 80)}”` : shown}`, content: asData(`web page ${finalUrl.toString()}`, pageText),
    preview: { kind: "page", title: title || shown, url: finalUrl.toString(), content: pageText },
  };
}

async function webSearch(args, fetcher, environment) {
  const key = searchKey(environment);
  const query = typeof args.query === "string" ? args.query.trim().slice(0, 400) : "";
  if (!key) return { ok: false, label: "Web search is not set up", content: "No search key is configured (ATLAS_TAVILY_API_KEY)." };
  if (!query) return { ok: false, label: "Empty search", content: "The search query was empty." };
  const response = await fetcher("https://api.tavily.com/search", {
    method: "POST",
    signal: AbortSignal.timeout(TOOL_TIMEOUT_MS),
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({ query, max_results: 6, search_depth: "basic", include_answer: false }),
  });
  if (!response.ok) return { ok: false, label: `Search failed for “${query.slice(0, 60)}”`, content: `The search service answered ${response.status}.` };
  const body = await response.json();
  const results = Array.isArray(body?.results) ? body.results.slice(0, 6) : [];
  const lines = results.map((result, index) => `${index + 1}. ${String(result?.title ?? "").slice(0, 160)}\n   ${String(result?.url ?? "")}\n   ${String(result?.content ?? "").replace(/\s+/gu, " ").slice(0, 400)}`);
  return { ok: true, label: `Searched the web for “${query.slice(0, 60)}” (${results.length} results)`, content: asData(`web search: ${query}`, lines.join("\n") || "No results.") };
}

async function repositoryAccess(args, context) {
  const repository = typeof args.repository === "string" ? args.repository.trim().toLowerCase().replace(/^https:\/\/github\.com\//u, "").replace(/\.git$/u, "") : "";
  if (!REPOSITORY_PATTERN.test(repository)) return { error: { ok: false, label: "Invalid repository", content: "Use the owner/name form." } };
  if (!context.allowlist?.has(repository)) return { error: { ok: false, label: `${repository} is not connected`, content: `${repository} is not on this workspace's allowlist, so Atlas cannot read it.` } };
  const token = await context.githubToken?.();
  if (!token) return { error: { ok: false, label: "GitHub is not connected", content: "No GitHub credential is configured for the hosted app." } };
  return { repository, token };
}

function githubHeaders(token) {
  return { accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "user-agent": "atlas-chat", "x-github-api-version": "2022-11-28" };
}

function encodePath(path) {
  return path.split("/").filter(Boolean).map(encodeURIComponent).join("/");
}

/** Branch/tag/HEAD to the commit it points at right now. `{ commit: null }` means "could not pin": the caller reads uncached. */
async function resolveCommit(cache, upstream, repository, ref) {
  if (/^[a-f0-9]{40,64}$/u.test(ref)) return { commit: ref };
  return cache.resolveRef(`${repository}#${ref || "HEAD"}`, async () => {
    const wait = cache.blockedForMs();
    if (wait > 0) { cache.noteBlocked("commits"); return { value: { commit: null, failure: { rateLimited: wait } }, cache: false }; }
    const { response, observation } = await upstream(`https://api.github.com/repos/${repository}/commits/${ref ? encodePath(ref) : "HEAD"}`, { accept: "application/vnd.github.sha" });
    holdOffAfterLimit(cache, observation);
    if (!response.ok) return { value: { commit: null, failure: { status: response.status, observation } }, cache: false };
    const commit = (await response.text()).trim();
    return /^[a-f0-9]{40,64}$/u.test(commit) ? { value: { commit }, cache: true } : { value: { commit: null }, cache: false };
  });
}

/** Fetch one path at one commit (or the default branch when `commit` is null) and shape it for caching. */
async function loadRepositoryEntry({ cache, upstream, repository, path, commit }) {
  const wait = cache.blockedForMs();
  if (wait > 0) { cache.noteBlocked("contents"); return { value: { failure: { rateLimited: wait } }, cache: false }; }
  const { response, observation } = await upstream(`https://api.github.com/repos/${repository}/contents/${encodePath(path)}${commit ? `?ref=${encodeURIComponent(commit)}` : ""}`);
  holdOffAfterLimit(cache, observation);
  if (!response.ok) return { value: { failure: { status: response.status, observation } }, cache: false };
  const body = await response.json();
  if (Array.isArray(body)) {
    const entries = body.slice(0, 300).map((entry) => `${entry?.type === "dir" ? "dir " : "file"} ${entry?.path ?? ""}`);
    return { value: { kind: "dir", entries, total: body.length }, cache: true, bytes: entries.join("\n").length * 2 + 64 };
  }
  if (body?.type !== "file") return { value: { skip: { label: "Skipped", content: `That path is a ${body?.type ?? "non-file"}.` } }, cache: false };
  if (typeof body.content !== "string" || body.encoding !== "base64") return { value: { skip: { label: "Skipped", content: "The file is too large to read through the contents API." } }, cache: false };
  const bytes = Uint8Array.from(atob(body.content.replace(/\s+/gu, "")), (character) => character.charCodeAt(0));
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  if (text.includes("\u0000")) return { value: { skip: { label: "Skipped", content: "The file is binary." } }, cache: false };
  return { value: { kind: "file", text, sha: body.sha }, cache: true, bytes: text.length * 2 + 64 };
}

/** A GitHub rate limit pauses uncached reads for a bounded time instead of letting the model hammer a refusing API. */
function holdOffAfterLimit(cache, observation) {
  const { outcome, rateLimit } = observation;
  if (outcome === "primary_rate_limit") cache.block(rateLimit.resetEpochSeconds === null ? 30_000 : rateLimit.resetEpochSeconds * 1000 - Date.now());
  else if (outcome === "secondary_rate_limit") cache.block(rateLimit.retryAfterMs ?? 30_000);
  else if (outcome === "rate_limit_unknown") cache.block(10_000);
}

/** Say which kind of refusal it was: they have different remedies, and only a rate limit passes with time. */
function githubReadFailure(shown, failure, { missing }) {
  if (failure.rateLimited) {
    return { ok: false, label: `GitHub rate limit: ${shown}`, content: `GitHub's rate limit for Atlas's credential is exhausted. Do not retry in a loop; try again in about ${Math.max(1, Math.ceil(failure.rateLimited / 1000))} seconds. Files already read in this session are still available.` };
  }
  const { status, observation } = failure;
  const outcome = observation?.outcome;
  if (status === 404) return { ok: false, label: `No ${shown}`, content: missing.startsWith("That path") ? missing : `${missing} does not exist.` };
  if (outcome === "primary_rate_limit" || outcome === "secondary_rate_limit" || outcome === "rate_limit_unknown") {
    return { ok: false, label: `GitHub rate limit: ${shown}`, content: `GitHub answered ${status}: the rate limit for Atlas's credential is exhausted. Do not retry in a loop; wait before reading more files.` };
  }
  if (status === 401) return { ok: false, label: `Could not read ${shown}`, content: "GitHub answered 401: Atlas's credential was rejected. This is not a rate limit; retrying will not help." };
  if (status === 403) return { ok: false, label: `Could not read ${shown}`, content: "GitHub answered 403: Atlas's credential lacks access to this repository. This is a permission problem, not a rate limit; retrying will not help." };
  return { ok: false, label: `Could not read ${shown}`, content: `GitHub answered ${status}.` };
}

async function readRepositoryFile(args, fetcher, context) {
  const offset = args.offset ?? 0;
  const maxChars = args.maxChars ?? DEFAULT_FILE_CHARS;
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(maxChars) || maxChars < 256 || maxChars > MAX_FILE_CHARS || (args.fileSha !== undefined && !/^[a-f0-9]{40,64}$/u.test(args.fileSha)) || (offset > 0 && !args.fileSha)) {
    return { ok: false, label: "Invalid file page", content: "Use a nonnegative integer offset, maxChars between 256 and 4000, and the previous page's fileSha when continuing." };
  }
  const access = await repositoryAccess(args, context);
  if (access.error) return access.error;
  const path = typeof args.path === "string" ? args.path.trim().replace(/^\/+/u, "").slice(0, 400) : "";
  if (path.split("/").includes("..")) return { ok: false, label: "Invalid path", content: "Paths cannot contain '..'." };
  const ref = typeof args.ref === "string" && /^[\w./-]{1,200}$/u.test(args.ref) ? args.ref : "";
  const shown = `${access.repository}/${path}`.replace(/\/$/u, "");
  // Authorization (allowlist + credential, above) has passed. Only now may cached content be returned.
  const cache = context.repositoryCache ?? repositoryContentCache;
  const upstream = (url, extraHeaders = {}) => observedGitHubFetch(fetcher, url, { signal: AbortSignal.timeout(TOOL_TIMEOUT_MS), headers: { ...githubHeaders(access.token), ...extraHeaders } }, { source: "chat_repository_read", observe: context.observe });
  const resolved = await resolveCommit(cache, upstream, access.repository, ref);
  if (resolved.failure) return githubReadFailure(shown, resolved.failure, { missing: `${ref || "default branch"} on ${access.repository}` });
  // With a pinned commit the file is fetched once and every page is cut from it. Without one (resolution gave no usable commit) read straight through, uncached.
  const fetchEntry = () => loadRepositoryEntry({ cache, upstream, repository: access.repository, path, commit: resolved.commit });
  const loaded = resolved.commit ? await cache.getOrLoad(`${access.repository}@${resolved.commit}:${path}`, fetchEntry) : (await fetchEntry()).value;
  if (loaded.failure) return githubReadFailure(shown, loaded.failure, { missing: "That path does not exist on that ref." });
  if (loaded.skip) return { ok: false, label: `${loaded.skip.label} ${shown}`, content: loaded.skip.content };
  if (loaded.kind === "dir") return { ok: true, label: `Listed ${shown || access.repository} (${loaded.total} entries)`, content: asData(`repository ${access.repository} directory ${path || "/"}`, loaded.entries.join("\n")) };
  const body = { sha: loaded.sha };
  const text = loaded.text;
  if (args.fileSha && args.fileSha !== body.sha) return { ok: false, label: `File changed: ${shown}`, content: "The file changed since the previous page. Read again from offset 0; do not combine these versions." };
  if (offset > text.length) return { ok: false, label: "File offset out of range", content: `This file contains ${text.length} characters. Read again from offset 0.` };
  let end = Math.min(text.length, offset + maxChars);
  // Do not split a UTF-16 surrogate pair at a generated continuation boundary.
  if (end < text.length && /[\uD800-\uDBFF]/u.test(text[end - 1])) end -= 1;
  const fileText = text.slice(offset, end);
  const fileSha = typeof body.sha === "string" && /^[a-f0-9]{40,64}$/u.test(body.sha) ? body.sha : null;
  const nextOffset = end < text.length ? end : null;
  const page = { offset, end, totalChars: text.length, nextOffset, fileSha };
  const paging = `File page: ${JSON.stringify(page)}\n${nextOffset === null ? "End of file." : "More content omitted. Call read_repository_file with nextOffset as offset and fileSha to continue. Do not assume omitted code."}\n\n`;
  return {
    ok: true, label: `Read ${shown}`, content: asData(`repository ${access.repository} file ${path}`, paging + fileText),
    page,
    preview: { kind: "file", title: path, repository: access.repository, path, content: fileText, page },
  };
}

async function searchRepositoryCode(args, fetcher, context) {
  const access = await repositoryAccess(args, context);
  if (access.error) return access.error;
  const query = typeof args.query === "string" ? args.query.replace(/\b(repo|org|user):\S+/giu, "").trim().slice(0, 200) : "";
  if (!query) return { ok: false, label: "Empty search", content: "The search query was empty." };
  const { response } = await observedGitHubFetch(fetcher, `https://api.github.com/search/code?per_page=15&q=${encodeURIComponent(`${query} repo:${access.repository}`)}`, {
    signal: AbortSignal.timeout(TOOL_TIMEOUT_MS), headers: githubHeaders(access.token),
  }, { source: "chat_repository_search", observe: context.observe });
  if (!response.ok) return { ok: false, label: `Code search failed in ${access.repository}`, content: `GitHub answered ${response.status}.` };
  const body = await response.json();
  const items = Array.isArray(body?.items) ? body.items : [];
  const paths = items.map((item) => item?.path).filter((path) => typeof path === "string");
  return { ok: true, label: `Searched ${access.repository} for “${query.slice(0, 60)}” (${paths.length} files)`, content: asData(`code search in ${access.repository}: ${query}`, paths.join("\n") || "No matches.") };
}

/** What the chat shows while a tool call is running. */
export function pendingLabel(call) {
  const args = parseArguments(call) ?? {};
  const name = call?.function?.name ?? "";
  if (name === "read_web_page") {
    const url = publicPageUrl(args.url);
    return `Reading ${url ? url.host + url.pathname : "a web page"}…`;
  }
  if (name === "web_search") return `Searching the web for “${String(args.query ?? "").slice(0, 60)}”…`;
  if (name === "read_repository_file") return `Reading ${String(args.repository ?? "")}/${String(args.path ?? "").replace(/^\/+/u, "")}…`.replace(/\/…$/u, "…");
  if (name === "search_repository_code") return `Searching ${String(args.repository ?? "")} for “${String(args.query ?? "").slice(0, 60)}”…`;
  return `Running ${name}…`;
}
