import { forgetMemory, memoryTableMissing, recallMemories, rememberMemory } from "../../../db/tenancy.mjs";
import { memoryContentLooksSecret } from "./memory-safety.mjs";

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
 * - remember / recall / forget: manage durable tenant-scoped memory.
 *
 * Everything these return is untrusted data. It goes back to the model in a
 * `<data source="…">` block that the content cannot close, and nothing here
 * can change anything anywhere.
 */

export const INSTANT_TOOL_NAMES = Object.freeze([
  "read_web_page", "web_search", "read_repository_file", "search_repository_code", "remember", "recall", "forget",
]);

const MAX_PAGE_BYTES = 600_000;
const MAX_TOOL_CHARS = 7_000;
const MAX_FILE_CHARS = 12_000;
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
  "Read a file, or list a directory, in a GitHub repository connected to this workspace (including your own, cornerstonemarketingus/atlas). Use it to answer questions about code accurately instead of guessing. Read-only.",
  {
    repository: { type: "string", description: "owner/name" },
    path: { type: "string", description: "Path inside the repository; empty or \"/\" for the root directory." },
    ref: { type: "string", description: "Branch, tag or commit. Defaults to the default branch." },
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
const REMEMBER = definition(
  "remember",
  "Save or update one durable memory for this tenant and user: a fact, preference, decision, convention, failure or command. Use it when the person tells you a lasting rule or corrects you.",
  {
    kind: { type: "string", enum: ["fact", "preference", "decision", "convention", "failure", "command"] },
    content: { type: "string", description: "The durable fact to remember. At most 1000 characters." },
    repository: { type: "string", description: "Optional owner/name repository this memory belongs to." },
  },
  ["kind", "content"],
);
const RECALL = definition(
  "recall",
  "Search durable saved memories for this tenant and user. Use it when you need a remembered convention, decision, command or past failure.",
  {
    query: { type: "string", description: "Keywords to search for." },
    repository: { type: "string", description: "Optional owner/name repository to prefer memories for." },
  },
  ["query"],
);
const FORGET = definition(
  "forget",
  "Delete one durable saved memory by id for this tenant and user.",
  { id: { type: "string", description: "The memory id to delete." } },
  ["id"],
);

/** The instant tools offered to the model; web search only when a search key is configured. */
export function instantToolDefinitions(environment = {}) {
  return [READ_WEB_PAGE, ...(searchKey(environment) ? [WEB_SEARCH] : []), READ_REPOSITORY_FILE, SEARCH_REPOSITORY_CODE, REMEMBER, RECALL, FORGET];
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
 * @param {{ fetcher?: typeof fetch, environment?: Record<string, string|undefined>, allowlist?: Set<string>, githubToken?: () => Promise<string|undefined>, d1?: any, memoryScope?: { tenantId: number, principal: string }, conversationId?: string }} context
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
    if (name === "remember") return await remember(args, context);
    if (name === "recall") return await recall(args, context);
    if (name === "forget") return await forget(args, context);
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

async function readRepositoryFile(args, fetcher, context) {
  const access = await repositoryAccess(args, context);
  if (access.error) return access.error;
  const path = typeof args.path === "string" ? args.path.trim().replace(/^\/+/u, "").slice(0, 400) : "";
  if (path.split("/").includes("..")) return { ok: false, label: "Invalid path", content: "Paths cannot contain '..'." };
  const ref = typeof args.ref === "string" && /^[\w./-]{1,200}$/u.test(args.ref) ? `?ref=${encodeURIComponent(args.ref)}` : "";
  const response = await fetcher(`https://api.github.com/repos/${access.repository}/contents/${encodePath(path)}${ref}`, {
    signal: AbortSignal.timeout(TOOL_TIMEOUT_MS), headers: githubHeaders(access.token),
  });
  const shown = `${access.repository}/${path}`.replace(/\/$/u, "");
  if (response.status === 404) return { ok: false, label: `No ${shown}`, content: "That path does not exist on that ref." };
  if (!response.ok) return { ok: false, label: `Could not read ${shown}`, content: `GitHub answered ${response.status}.` };
  const body = await response.json();
  if (Array.isArray(body)) {
    const entries = body.slice(0, 300).map((entry) => `${entry?.type === "dir" ? "dir " : "file"} ${entry?.path ?? ""}`);
    return { ok: true, label: `Listed ${shown || access.repository} (${body.length} entries)`, content: asData(`repository ${access.repository} directory ${path || "/"}`, entries.join("\n")) };
  }
  if (body?.type !== "file") return { ok: false, label: `Skipped ${shown}`, content: `That path is a ${body?.type ?? "non-file"}.` };
  if (typeof body.content !== "string" || body.encoding !== "base64") return { ok: false, label: `Skipped ${shown}`, content: "The file is too large to read through the contents API." };
  const bytes = Uint8Array.from(atob(body.content.replace(/\s+/gu, "")), (character) => character.charCodeAt(0));
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  if (text.includes("\u0000")) return { ok: false, label: `Skipped ${shown}`, content: "The file is binary." };
  const fileText = clip(text, MAX_FILE_CHARS);
  return {
    ok: true, label: `Read ${shown}`, content: asData(`repository ${access.repository} file ${path}`, fileText),
    preview: { kind: "file", title: path, repository: access.repository, path, content: fileText },
  };
}

async function searchRepositoryCode(args, fetcher, context) {
  const access = await repositoryAccess(args, context);
  if (access.error) return access.error;
  const query = typeof args.query === "string" ? args.query.replace(/\b(repo|org|user):\S+/giu, "").trim().slice(0, 200) : "";
  if (!query) return { ok: false, label: "Empty search", content: "The search query was empty." };
  const response = await fetcher(`https://api.github.com/search/code?per_page=15&q=${encodeURIComponent(`${query} repo:${access.repository}`)}`, {
    signal: AbortSignal.timeout(TOOL_TIMEOUT_MS), headers: githubHeaders(access.token),
  });
  if (!response.ok) return { ok: false, label: `Code search failed in ${access.repository}`, content: `GitHub answered ${response.status}.` };
  const body = await response.json();
  const items = Array.isArray(body?.items) ? body.items : [];
  const paths = items.map((item) => item?.path).filter((path) => typeof path === "string");
  return { ok: true, label: `Searched ${access.repository} for “${query.slice(0, 60)}” (${paths.length} files)`, content: asData(`code search in ${access.repository}: ${query}`, paths.join("\n") || "No matches.") };
}

async function remember(args, context) {
  const repository = memoryRepository(args.repository);
  const kind = typeof args.kind === "string" ? args.kind.trim() : "";
  const content = typeof args.content === "string" ? args.content.trim().slice(0, 1000) : "";
  if (!content) return memoryResult(false, "Nothing to remember", "The memory content was empty.");
  if (memoryContentLooksSecret(content)) return memoryResult(false, "Refused to store a secret", "I will not store secrets, tokens, passwords or private keys in memory.");
  const access = memoryAccess(context);
  if (access.error) return access.error;
  try {
    const outcome = await rememberMemory(access.d1, access.scope, { kind, content, repository, sourceConversationId: context.conversationId ?? null });
    const memory = outcome.memory;
    return memoryResult(true, outcome.created ? "Saved a memory" : "Updated a memory", [
      `id: ${memory?.id ?? "unknown"}`,
      `kind: ${kind}`,
      repository ? `repository: ${repository}` : "repository: shared",
      `content: ${content}`,
    ].join("\n"));
  } catch (error) {
    if (memoryTableMissing(error)) return memoryResult(false, "Memory is not set up yet", "The memory database has not been migrated yet.");
    return memoryResult(false, "Could not save memory", "The memory could not be saved.");
  }
}

async function recall(args, context) {
  const query = typeof args.query === "string" ? args.query.trim().slice(0, 300) : "";
  if (!query) return memoryResult(false, "Empty memory search", "The memory search query was empty.");
  const repository = memoryRepository(args.repository);
  const access = memoryAccess(context);
  if (access.error) return access.error;
  try {
    const memories = await recallMemories(access.d1, access.scope, { query, repository, limit: 15 });
    const lines = memories.map((memory) => `${memory.id} · ${memory.kind}${memory.repository ? ` · ${memory.repository}` : ""}\n${memory.content}`);
    return memoryResult(true, `Recalled ${memories.length} memories`, lines.join("\n\n") || "No memories matched.");
  } catch (error) {
    if (memoryTableMissing(error)) return memoryResult(false, "Memory is not set up yet", "The memory database has not been migrated yet.");
    return memoryResult(false, "Could not search memory", "The saved memories could not be searched.");
  }
}

async function forget(args, context) {
  const id = typeof args.id === "string" ? args.id.trim() : "";
  if (!id) return memoryResult(false, "Missing memory id", "Provide the memory id to delete.");
  const access = memoryAccess(context);
  if (access.error) return access.error;
  try {
    const deleted = await forgetMemory(access.d1, access.scope, id);
    return memoryResult(deleted, deleted ? "Deleted a memory" : "No memory deleted", deleted ? `id: ${id}` : "No saved memory with that id was found.");
  } catch (error) {
    if (memoryTableMissing(error)) return memoryResult(false, "Memory is not set up yet", "The memory database has not been migrated yet.");
    return memoryResult(false, "Could not delete memory", "The saved memory could not be deleted.");
  }
}

function memoryRepository(repository) {
  const normalized = typeof repository === "string" ? repository.trim().toLowerCase() : "";
  return /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/u.test(normalized) ? normalized : null;
}

function memoryAccess(context) {
  if (context?.d1 && context?.memoryScope) return { d1: context.d1, scope: context.memoryScope };
  return { error: memoryResult(false, "Memory is unavailable", "Memory is unavailable in this chat.") };
}

function memoryResult(ok, label, body) {
  return { ok, label, content: asData("memory", body) };
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
  if (name === "remember") return "Saving that to memory…";
  if (name === "recall") return `Searching memory for “${String(args.query ?? "").slice(0, 60)}”…`;
  if (name === "forget") return "Deleting that memory…";
  return `Running ${name}…`;
}
