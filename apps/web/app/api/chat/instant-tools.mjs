import { setTaskRunId } from "../../../db/tenancy.mjs";
import { workflowForMode } from "../tasks/dispatch.mjs";
import {
  fetchGitHubJson,
  githubReadHeaders,
  normalizePullRequest,
  normalizeRun,
  pullRequestForBranchRequest,
  workflowRunRequest,
  workflowRunsRequest,
} from "../tasks/github-runs.mjs";
import { activityFromRun } from "../tasks/run-activity.mjs";
import { assignRunsToTasks, coderBranchForTask, runUrl, taskStatusFromRun } from "../tasks/run-status.mjs";

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

export const INSTANT_TOOL_NAMES = Object.freeze([
  "read_web_page",
  "web_search",
  "read_repository_file",
  "search_repository_code",
  "get_task_status",
  "list_pull_requests",
  "read_pull_request",
  "read_ci_logs",
]);

const MAX_PAGE_BYTES = 600_000;
const MAX_TOOL_CHARS = 12_000;
const MAX_FILE_CHARS = 20_000;
const MAX_LOG_CHARS = 15_000;
const TOOL_TIMEOUT_MS = 12_000;
const REPOSITORY_PATTERN = /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/u;
const TASK_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const MAX_PULL_REQUEST_ENRICHMENTS = 5;

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
const GET_TASK_STATUS = definition(
  "get_task_status",
  "Read the live status of one Atlas task in this workspace, including its GitHub run, pull request, and current step when available. Read-only.",
  {
    taskId: { type: "string", description: "The Atlas task id." },
  },
  ["taskId"],
);
const LIST_PULL_REQUESTS = definition(
  "list_pull_requests",
  "List up to 20 pull requests in a connected GitHub repository, including authors, checks summaries and mergeability. Read-only.",
  {
    repository: { type: "string", description: "owner/name" },
    state: { type: "string", enum: ["open", "closed", "all"], description: "Defaults to open." },
  },
  ["repository"],
);
const READ_PULL_REQUEST = definition(
  "read_pull_request",
  "Read one pull request in a connected GitHub repository: description, changed files, checks and unresolved review comments. Read-only.",
  {
    repository: { type: "string", description: "owner/name" },
    number: { type: "integer", description: "Pull request number." },
  },
  ["repository", "number"],
);
const READ_CI_LOGS = definition(
  "read_ci_logs",
  "Read the failed CI log for a connected repository by workflow run id or job id, following GitHub's job-log redirect and redacting token-like strings. Read-only.",
  {
    repository: { type: "string", description: "owner/name" },
    runId: { type: "integer", description: "GitHub Actions workflow run id." },
    jobId: { type: "integer", description: "GitHub Actions workflow job id." },
  },
  ["repository"],
);

/** The instant tools offered to the model; web search only when a search key is configured. */
export function instantToolDefinitions(environment = {}) {
  return [
    READ_WEB_PAGE,
    ...(searchKey(environment) ? [WEB_SEARCH] : []),
    READ_REPOSITORY_FILE,
    SEARCH_REPOSITORY_CODE,
    GET_TASK_STATUS,
    LIST_PULL_REQUESTS,
    READ_PULL_REQUEST,
    READ_CI_LOGS,
  ];
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
 * @param {{ fetcher?: typeof fetch, environment?: Record<string, string|undefined>, allowlist?: Set<string>, githubToken?: () => Promise<string|undefined>, d1?: any, taskScope?: { tenantId: number, principal: string } | null }} context
 * @returns {Promise<{ ok: boolean, label: string, content: string }>}
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
    if (name === "get_task_status") return await getTaskStatus(args, fetcher, context);
    if (name === "list_pull_requests") return await listPullRequests(args, fetcher, context);
    if (name === "read_pull_request") return await readPullRequest(args, fetcher, context);
    if (name === "read_ci_logs") return await readCiLogs(args, fetcher, context);
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
  return { ok: true, label: `Read ${title ? `“${title.slice(0, 80)}”` : shown}`, content: asData(`web page ${finalUrl.toString()}`, clip(`${title ? `${title}\n\n` : ""}${text}`, MAX_TOOL_CHARS)) };
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

function normalizeRepository(value) {
  return typeof value === "string" ? value.trim().toLowerCase().replace(/^https:\/\/github\.com\//u, "").replace(/\.git$/u, "") : "";
}

async function githubAccessForRepository(repositoryValue, context) {
  const repository = normalizeRepository(repositoryValue);
  if (!REPOSITORY_PATTERN.test(repository)) return { error: { ok: false, label: "Invalid repository", content: "Use the owner/name form." } };
  if (!context.allowlist?.has(repository)) return { error: { ok: false, label: `${repository} is not connected`, content: `${repository} is not on this workspace's allowlist, so Atlas cannot read it.` } };
  const token = await context.githubToken?.();
  if (!token) return { error: { ok: false, label: "GitHub is not connected", content: "No GitHub credential is configured for the hosted app." } };
  return { repository, token };
}

async function repositoryAccess(args, context) {
  return githubAccessForRepository(args.repository, context);
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
  return { ok: true, label: `Read ${shown}`, content: asData(`repository ${access.repository} file ${path}`, clip(text, MAX_FILE_CHARS)) };
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

function jsonData(source, value, max = MAX_TOOL_CHARS) {
  return asData(source, clip(redactSecrets(JSON.stringify(value, null, 2)), max));
}

function validatePositiveInteger(value) {
  return Number.isInteger(value) && value > 0 ? value : null;
}

function currentStepFromActivity(activity) {
  return activity?.steps?.find((step) => step.state === "running")
    ?? activity?.steps?.find((step) => step.state === "failed")
    ?? activity?.steps?.find((step) => step.state === "pending")
    ?? activity?.steps?.at(-1)
    ?? null;
}

function stepSummary(step) {
  return step ? { label: step.label, state: step.state } : null;
}

function runState(run) {
  if (!run) return "missing";
  if (run.status === "completed") {
    if (run.conclusion === "success") return "passed";
    if (run.conclusion === "failure" || run.conclusion === "startup_failure" || run.conclusion === "timed_out" || run.conclusion === "action_required") return "failed";
    if (run.conclusion === "cancelled" || run.conclusion === "stale") return "cancelled";
    return "completed";
  }
  if (run.status === "in_progress") return "running";
  return "pending";
}

function summarizeWorkflowRuns(payload) {
  const listed = Array.isArray(payload?.workflow_runs) ? payload.workflow_runs.map(normalizeRun).filter((run) => run !== null) : [];
  const unique = [];
  const seen = new Set();
  for (const run of listed) {
    const key = run.name || `${run.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(run);
  }
  const summary = { overall: "missing", total: unique.length, passed: 0, failed: 0, running: 0, pending: 0, cancelled: 0 };
  for (const run of unique) {
    const state = runState(run);
    if (state === "passed") summary.passed += 1;
    else if (state === "failed") summary.failed += 1;
    else if (state === "running") summary.running += 1;
    else if (state === "pending") summary.pending += 1;
    else if (state === "cancelled") summary.cancelled += 1;
  }
  summary.overall = summary.failed > 0 ? "failed"
    : summary.running > 0 ? "running"
      : summary.pending > 0 ? "pending"
        : summary.total > 0 && summary.passed === summary.total && summary.cancelled === 0 ? "passed"
          : summary.total > 0 ? "mixed"
            : "missing";
  return {
    ...summary,
    runs: unique.map((run) => ({
      name: run.name,
      id: run.id,
      url: run.htmlUrl,
      status: run.status,
      conclusion: run.conclusion,
    })),
  };
}

function pullRequestMergeable(detail) {
  if (detail?.mergeable_state && typeof detail.mergeable_state === "string") return detail.mergeable_state;
  if (detail?.mergeable === true) return "mergeable";
  if (detail?.mergeable === false) return "conflicting";
  return "unknown";
}

async function fetchGitHubGraphql({ token, query, variables }, fetcher) {
  const response = await fetcher("https://api.github.com/graphql", {
    method: "POST",
    signal: AbortSignal.timeout(TOOL_TIMEOUT_MS),
    headers: { ...githubReadHeaders(token), "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  if (!response.ok) return null;
  const body = await response.json().catch(() => null);
  if (!body || body.errors) return null;
  return body.data ?? null;
}

async function fetchGitHubText(request, fetcher) {
  const response = await fetcher(request.url, { ...request.init, signal: AbortSignal.timeout(TOOL_TIMEOUT_MS), redirect: "manual" });
  if (response.status >= 300 && response.status < 400) {
    const location = trustedGitHubLogUrl(response.headers.get("location"));
    if (!location) return null;
    const redirected = await fetcher(location.toString(), {
      method: "GET",
      signal: AbortSignal.timeout(TOOL_TIMEOUT_MS),
      headers: { accept: "text/plain", "user-agent": "atlas-chat" },
      redirect: "follow",
    });
    if (!redirected.ok) return null;
    return await redirected.text();
  }
  if (!response.ok) return null;
  return await response.text();
}

function trustedGitHubLogUrl(raw) {
  let url;
  try { url = new URL(String(raw ?? "")); } catch { return null; }
  if (url.protocol !== "https:" || url.username || url.password) return null;
  const host = url.hostname.toLowerCase();
  if (host === "objects.githubusercontent.com" || host.endsWith(".actions.githubusercontent.com") || /^productionresultssa\d+\.blob\.core\.windows\.net$/u.test(host)) return url;
  return null;
}

function readTaskRequest(scope, taskId) {
  return scope
    ? {
      sql: `SELECT task_id AS taskId, tenant_id AS tenantId, requested_by AS requestedBy, repository, branch, mode, objective, merge_policy AS mergePolicy, github_run_id AS githubRunId, conversation_id AS conversationId, execution_provider AS executionProvider, created_at AS createdAt
            FROM tasks
            WHERE task_id = ? AND tenant_id = ? AND requested_by = ?`,
      params: [taskId, scope.tenantId, scope.principal],
    }
    : null;
}

async function resolveRunForTask(row, repository, token, fetcher, context) {
  const workflow = workflowForMode(row.mode, {
    defaultWorkflow: context.environment?.ATLAS_GITHUB_WORKFLOW,
    coderWorkflow: context.environment?.ATLAS_CODER_WORKFLOW,
  });
  let runId = typeof row.githubRunId === "number" ? row.githubRunId : null;
  const listed = runId === null
    ? await fetchGitHubJson(workflowRunsRequest({ token, repository, workflow }), fetcher)
    : null;
  const candidateRuns = Array.isArray(listed?.workflow_runs) ? listed.workflow_runs.map(normalizeRun).filter((run) => run !== null) : [];
  if (runId === null) {
    const assignment = assignRunsToTasks(
      [{ taskId: row.taskId, createdAt: row.createdAt, workflow, githubRunId: row.githubRunId }],
      candidateRuns.map((run) => ({ ...run, workflow })),
    )[0] ?? null;
    runId = assignment?.runId ?? null;
    if (runId !== null && context.d1) {
      try { await setTaskRunId(context.d1, { tenantId: row.tenantId, principal: row.requestedBy }, row.taskId, runId); } catch { /* best effort */ }
    }
  }
  const listedRun = runId === null ? null : candidateRuns.find((run) => run.id === runId) ?? null;
  const runPayload = runId === null
    ? null
    : listedRun
      ? {
        id: listedRun.id,
        name: listedRun.name,
        created_at: listedRun.createdAt,
        event: listedRun.event,
        status: listedRun.status,
        conclusion: listedRun.conclusion,
        html_url: listedRun.htmlUrl,
      }
      : await fetchGitHubJson(workflowRunRequest({ token, repository, runId }), fetcher);
  return { runId, runPayload, run: normalizeRun(runPayload) };
}

async function readTaskStatusPayload(taskId, fetcher, context) {
  if (!TASK_ID_PATTERN.test(taskId)) return { error: { ok: false, label: "Unknown task", content: "Task ids use Atlas's UUID form." } };
  if (!context.d1 || !context.taskScope) return { error: { ok: false, label: "Task status is unavailable", content: "Task lookups are unavailable in this chat." } };
  const request = readTaskRequest(context.taskScope, taskId);
  const row = await context.d1.prepare(request.sql).bind(...request.params).first();
  if (!row) return { error: { ok: false, label: "Unknown task", content: "That task does not exist in this workspace." } };
  const access = await githubAccessForRepository(row.repository, context);
  if (access.error) return access.error;
  const { runId, runPayload, run } = await resolveRunForTask(row, access.repository, access.token, fetcher, context);
  const pullRequestPayload = row.mode === "coder"
    ? await fetchGitHubJson(pullRequestForBranchRequest({ token: access.token, repository: access.repository, branch: coderBranchForTask(row.taskId) }), fetcher)
    : null;
  const pullRequest = Array.isArray(pullRequestPayload) ? normalizePullRequest(pullRequestPayload[0]) : null;
  const jobs = runId === null
    ? null
    : await fetchGitHubJson({
      url: `https://api.github.com/repos/${access.repository}/actions/runs/${runId}/jobs?per_page=10`,
      init: { method: "GET", headers: githubReadHeaders(access.token) },
    }, fetcher);
  const activity = runPayload ? activityFromRun(runPayload, jobs ?? {}) : { steps: [] };
  return {
    taskId: row.taskId,
    repository: access.repository,
    branch: row.branch,
    mode: row.mode,
    objective: row.objective,
    mergePolicy: row.mergePolicy,
    status: row.executionProvider === "private" && run === null ? "dispatched" : taskStatusFromRun(run),
    run: runId === null ? null : { id: runId, url: run?.htmlUrl ?? runUrl(access.repository, runId), status: run?.status ?? null, conclusion: run?.conclusion ?? null },
    pullRequest: pullRequest ? { number: pullRequest.number, url: pullRequest.url, state: pullRequest.state, merged: pullRequest.merged } : null,
    currentStep: stepSummary(currentStepFromActivity(activity)),
  };
}

async function getTaskStatus(args, fetcher, context) {
  const taskId = typeof args.taskId === "string" ? args.taskId.trim().toLowerCase() : "";
  const payload = await readTaskStatusPayload(taskId, fetcher, context);
  if (payload.error) return payload.error;
  return { ok: true, label: `Read status for task ${taskId.slice(0, 8)}`, content: jsonData(`task status ${taskId}`, payload) };
}

function pullsRequest(repository, state) {
  return {
    url: `https://api.github.com/repos/${repository}/pulls?state=${encodeURIComponent(state)}&sort=updated&direction=desc&per_page=20`,
    init: { method: "GET" },
  };
}

function pullRequestDetailRequest(repository, number) {
  return { url: `https://api.github.com/repos/${repository}/pulls/${number}`, init: { method: "GET" } };
}

function pullRequestFilesRequest(repository, number) {
  return { url: `https://api.github.com/repos/${repository}/pulls/${number}/files?per_page=100`, init: { method: "GET" } };
}

function pullRequestRunsRequest(repository, headSha) {
  return {
    url: `https://api.github.com/repos/${repository}/actions/runs?event=pull_request&per_page=20&head_sha=${encodeURIComponent(headSha)}`,
    init: { method: "GET" },
  };
}

const REVIEW_THREADS_QUERY = `
  query AtlasPullRequestThreads($owner: String!, $name: String!, $number: Int!) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        reviewThreads(first: 50) {
          nodes {
            isResolved
            comments(last: 1) {
              nodes {
                body
                path
                line
                originalLine
              }
            }
          }
        }
      }
    }
  }
`;

function unresolvedReviewCommentsFrom(data) {
  const nodes = data?.repository?.pullRequest?.reviewThreads?.nodes;
  if (!Array.isArray(nodes)) return [];
  return nodes
    .filter((thread) => thread && thread.isResolved === false)
    .map((thread) => thread.comments?.nodes?.at(-1))
    .filter(Boolean)
    .map((comment) => ({
      path: typeof comment.path === "string" ? comment.path : null,
      line: validatePositiveInteger(comment.line) ?? validatePositiveInteger(comment.originalLine),
      body: typeof comment.body === "string" ? comment.body : "",
    }));
}

async function listPullRequests(args, fetcher, context) {
  const access = await repositoryAccess(args, context);
  if (access.error) return access.error;
  const state = typeof args.state === "string" && ["open", "closed", "all"].includes(args.state) ? args.state : "open";
  const response = await fetcher(pullsRequest(access.repository, state).url, {
    signal: AbortSignal.timeout(TOOL_TIMEOUT_MS),
    headers: githubHeaders(access.token),
  });
  if (!response.ok) return { ok: false, label: `Could not list pull requests in ${access.repository}`, content: `GitHub answered ${response.status}.` };
  const listed = await response.json().catch(() => null);
  const pulls = Array.isArray(listed) ? listed.slice(0, 20) : [];
  const enriched = await Promise.all(pulls.map(async (pull, index) => {
    if (index >= MAX_PULL_REQUEST_ENRICHMENTS) {
      return {
        number: pull.number,
        title: String(pull.title ?? ""),
        author: typeof pull?.user?.login === "string" ? pull.user.login : null,
        url: typeof pull.html_url === "string" ? pull.html_url : null,
        state: typeof pull.state === "string" ? pull.state : null,
        checks: { overall: "missing", total: 0, passed: 0, failed: 0, running: 0, pending: 0, cancelled: 0, runs: [] },
        mergeable: typeof pull.mergeable_state === "string" ? pull.mergeable_state : "unknown",
      };
    }
    const [detail, runs] = await Promise.all([
      fetchGitHubJson({ ...pullRequestDetailRequest(access.repository, pull.number), init: { method: "GET", headers: githubHeaders(access.token) } }, fetcher),
      pull?.head?.sha
        ? fetchGitHubJson({ ...pullRequestRunsRequest(access.repository, pull.head.sha), init: { method: "GET", headers: githubHeaders(access.token) } }, fetcher)
        : null,
    ]);
    return {
      number: pull.number,
      title: String(pull.title ?? ""),
      author: typeof pull?.user?.login === "string" ? pull.user.login : null,
      url: typeof pull.html_url === "string" ? pull.html_url : null,
      state: typeof pull.state === "string" ? pull.state : null,
      checks: summarizeWorkflowRuns(runs),
      mergeable: pullRequestMergeable(detail),
    };
  }));
  return { ok: true, label: `Listed ${enriched.length} pull requests in ${access.repository}`, content: jsonData(`pull requests in ${access.repository}`, enriched) };
}

async function readPullRequest(args, fetcher, context) {
  const access = await repositoryAccess(args, context);
  if (access.error) return access.error;
  const number = validatePositiveInteger(args.number);
  if (number === null) return { ok: false, label: "Invalid pull request number", content: "Use a positive integer pull request number." };
  const detail = await fetchGitHubJson({ ...pullRequestDetailRequest(access.repository, number), init: { method: "GET", headers: githubHeaders(access.token) } }, fetcher);
  if (!detail) return { ok: false, label: `Could not read PR #${number}`, content: "GitHub did not return that pull request." };
  const [filesPayload, runsPayload, reviewThreads] = await Promise.all([
    fetchGitHubJson({ ...pullRequestFilesRequest(access.repository, number), init: { method: "GET", headers: githubHeaders(access.token) } }, fetcher),
    detail?.head?.sha
      ? fetchGitHubJson({ ...pullRequestRunsRequest(access.repository, detail.head.sha), init: { method: "GET", headers: githubHeaders(access.token) } }, fetcher)
      : null,
    fetchGitHubGraphql({
      token: access.token,
      query: REVIEW_THREADS_QUERY,
      variables: { owner: access.repository.split("/")[0], name: access.repository.split("/")[1], number },
    }, fetcher),
  ]);
  const files = Array.isArray(filesPayload) ? filesPayload.slice(0, 100).map((file) => ({
    path: typeof file.filename === "string" ? file.filename : null,
    status: typeof file.status === "string" ? file.status : null,
    additions: Number.isInteger(file.additions) ? file.additions : 0,
    deletions: Number.isInteger(file.deletions) ? file.deletions : 0,
  })) : [];
  const payload = {
    number,
    title: String(detail.title ?? ""),
    state: typeof detail.state === "string" ? detail.state : null,
    mergeable: pullRequestMergeable(detail),
    url: typeof detail.html_url === "string" ? detail.html_url : null,
    description: typeof detail.body === "string" ? detail.body : "",
    changedFiles: files,
    checks: summarizeWorkflowRuns(runsPayload),
    unresolvedReviewComments: unresolvedReviewCommentsFrom(reviewThreads),
  };
  return { ok: true, label: `Read PR #${number} in ${access.repository}`, content: jsonData(`pull request ${access.repository}#${number}`, payload) };
}

function actionsJobRequest(repository, jobId, suffix = "") {
  return { url: `https://api.github.com/repos/${repository}/actions/jobs/${jobId}${suffix}`, init: { method: "GET" } };
}

function actionsRunJobsRequest(repository, runId) {
  return { url: `https://api.github.com/repos/${repository}/actions/runs/${runId}/jobs?per_page=100`, init: { method: "GET" } };
}

function chooseFailedJob(payload) {
  const jobs = Array.isArray(payload?.jobs) ? payload.jobs : [];
  return jobs.find((job) => isFailedJob(job)) ?? null;
}

function isFailedJob(job) {
  return ["failure", "timed_out", "cancelled", "action_required"].includes(String(job?.conclusion ?? ""));
}

function firstInterestingLogLine(lines) {
  const patterns = [/##\[error\]/u, /\b(?:FAIL|Error:|AssertionError|Traceback|panic:|npm ERR!|not ok \d+)\b/u];
  const index = lines.findIndex((line) => patterns.some((pattern) => pattern.test(line)));
  return index >= 0 ? index : Math.max(lines.length - 80, 0);
}

function extractLogSnippet(text) {
  const lines = String(text ?? "").replace(/\r\n/gu, "\n").split("\n");
  const start = Math.max(firstInterestingLogLine(lines) - 60, 0);
  const end = Math.min(start + 400, lines.length);
  return redactSecrets(lines.slice(start, end).join("\n")).slice(0, MAX_LOG_CHARS);
}

const TOKEN_PATTERNS = [
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/gu,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/gu,
  /\b(?:Bearer|token)\s+[A-Za-z0-9._=-]{16,}\b/gu,
];

function redactSecrets(text) {
  let redacted = String(text ?? "");
  for (const pattern of TOKEN_PATTERNS) redacted = redacted.replace(pattern, "[REDACTED]");
  redacted = redacted.replace(
    /(\b(?:authorization|token|secret|password|passwd|cookie|api[_-]?key)\s*[:=]\s*)(["']?)[A-Za-z0-9._/+=-]{16,}\2/giu,
    (_match, prefix, quote) => `${prefix}${quote}[REDACTED]${quote}`,
  );
  return redacted;
}

async function readCiLogs(args, fetcher, context) {
  const access = await repositoryAccess(args, context);
  if (access.error) return access.error;
  const runId = validatePositiveInteger(args.runId);
  const jobId = validatePositiveInteger(args.jobId);
  if (runId === null && jobId === null) return { ok: false, label: "Missing CI target", content: "Provide a workflow run id or job id." };
  const job = jobId !== null
    ? await fetchGitHubJson({ ...actionsJobRequest(access.repository, jobId), init: { method: "GET", headers: githubHeaders(access.token) } }, fetcher)
    : chooseFailedJob(await fetchGitHubJson({ ...actionsRunJobsRequest(access.repository, runId), init: { method: "GET", headers: githubHeaders(access.token) } }, fetcher));
  if (!job || !isFailedJob(job)) return { ok: false, label: `No failed job found in ${access.repository}`, content: "GitHub did not report a failed job for that run." };
  const logs = await fetchGitHubText({ ...actionsJobRequest(access.repository, job.id, "/logs"), init: { method: "GET", headers: githubHeaders(access.token) } }, fetcher);
  if (logs === null) return { ok: false, label: `Could not read CI logs for job ${job.id}`, content: "GitHub did not return that job log." };
  const payload = {
    repository: access.repository,
    job: {
      id: job.id,
      runId: job.run_id ?? runId,
      name: job.name ?? null,
      status: job.status ?? null,
      conclusion: job.conclusion ?? null,
      url: job.html_url ?? null,
    },
    excerpt: extractLogSnippet(logs),
  };
  return { ok: true, label: `Read CI logs for ${payload.job.name ?? `job ${job.id}`}`, content: jsonData(`ci logs ${access.repository} job ${job.id}`, payload, MAX_LOG_CHARS) };
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
  if (name === "get_task_status") return `Reading task ${String(args.taskId ?? "").slice(0, 12)}…`;
  if (name === "list_pull_requests") return `Listing pull requests in ${String(args.repository ?? "")}…`;
  if (name === "read_pull_request") return `Reading PR #${String(args.number ?? "")} in ${String(args.repository ?? "")}…`;
  if (name === "read_ci_logs") return `Reading CI logs in ${String(args.repository ?? "")}…`;
  return `Running ${name}…`;
}
