import { githubToolError } from "./github-tool-error.mjs";
import { githubRequestObservation, logGitHubObservation } from "../tasks/github-observability.mjs";

const QUALIFIERS = new Set(["filename", "path", "language", "extension", "size", "in", "fork"]);

/** REST code search uses legacy syntax, not the website's regex/symbol syntax. */
export function repositoryQuery(args) {
  if (typeof args.query !== "string" || args.query.length > 4096) throw new Error("Use a query of at most 256 search-term characters.");
  const tokens = args.query.trim().match(/(?:[^\s"]|"[^"]*")+/gu) ?? [];
  if ((args.query.match(/"/gu) ?? []).length % 2) throw new Error("Close the quoted search phrase.");
  const terms = []; const filters = [];
  for (const token of tokens) {
    if (/^\/?(?:repo|org|user):/iu.test(token)) continue;
    if (/^(AND|OR|NOT)$/u.test(token)) throw new Error("Use simple terms or a quoted phrase with legacy GitHub qualifiers; boolean expressions are unsupported here.");
    const qualifier = /^([a-z]+):(.*)$/iu.exec(token);
    if (qualifier) {
      if (!QUALIFIERS.has(qualifier[1].toLowerCase()) || !qualifier[2]) throw new Error("Use legacy qualifiers: filename, path, language, extension, size, in or fork.");
      filters.push(token);
    } else {
      if (/^\/.*\/$/u.test(token) || /[()]/u.test(token)) throw new Error("Use literal terms instead of regular expressions or grouped expressions.");
      terms.push(token);
    }
  }
  for (const key of ["filename", "path"]) {
    if (args[key] !== undefined) {
      if (typeof args[key] !== "string" || !/^[\w./-]{1,200}$/u.test(args[key]) || args[key].split("/").includes("..")) throw new Error(`Use a relative ${key} filter without traversal or query syntax.`);
      filters.push(`${key}:${args[key]}`);
    }
  }
  if (terms.join(" ").length > 256) throw new Error("Use at most 256 search-term characters; narrow the search with path or filename.");
  if (!terms.length && !filters.some(filter => /^filename:/iu.test(filter))) throw new Error("Include a search term or a filename filter.");
  const query = [...terms, ...filters].join(" ");
  const literal = terms.map(term => term.startsWith('"') ? term : `"${term}"`);
  const corrected = [...literal, ...filters].join(" ");
  return { query, corrected: terms.length && corrected !== query ? corrected : null };
}

export async function searchRepository({ args, repository, headers, fetcher, context, timeoutMs, asData, readFile }) {
  let parsed;
  try { parsed = repositoryQuery(args); } catch (error) {
    const failure = { ok: false, label: "Invalid repository search", error: { operation: "search_repository_code", category: "invalid_request", cause: error.message, action: "Correct the query or read a known file; do not repeat the identical request." }, content: `${error.message} Correct the query or use read_repository_file with a known path.` };
    if (typeof args.filePath === "string" && args.filePath) {
      const read = await readFile({ repository, path: args.filePath, ...(args.ref ? { ref: args.ref } : {}) });
      return { ...read, label: read.ok ? `Search invalid; ${read.label} instead` : read.label, recovery: { attempts: [failure.error], fallback: "read_repository_file", succeeded: read.ok }, content: `${failure.content}\nSearch did not succeed. Direct file fallback ${read.ok ? "succeeded" : "failed"}:\n${read.content}` };
    }
    return failure;
  }
  const page = args.page ?? 1; const perPage = args.perPage ?? 15;
  if (!Number.isSafeInteger(page) || !Number.isSafeInteger(perPage) || page < 1 || perPage < 1 || perPage > 100 || (page - 1) * perPage >= 1000) {
    return { ok: false, label: "Invalid search page", error: { operation: "search_repository_code", category: "invalid_request" }, content: "Use page >= 1 and perPage between 1 and 100, within GitHub's first 1000 results. Narrow with filename/path beyond that limit." };
  }
  const attempts = [];
  let query = parsed.query;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const url = `https://api.github.com/search/code?per_page=${perPage}&page=${page}&q=${encodeURIComponent(`${query} repo:${repository}`)}`;
    const startedAt = Date.now();
    let response; let failure;
    try {
      response = await fetcher(url, { signal: AbortSignal.timeout(timeoutMs), headers });
      if (!response.ok) failure = await githubToolError(response, "search_repository_code");
    } finally {
      try { (context.observeGitHub ?? logGitHubObservation)(githubRequestObservation({ url, response, startedAt, endedAt: Date.now(), source: "hosted_chat", outcome: response?.ok ? "success" : "http_failure" })); } catch { /* observability is not execution */ }
    }
    if (failure) {
      attempts.push(failure.error);
      // Retry once as literal terms, preserving every filter and repository.
      if (failure.error.category === "invalid_request" && attempt === 0 && parsed.corrected) {
        query = parsed.corrected; continue;
      }
      const exactPath = args.filePath;
      if (["invalid_request", "not_found", "permission", "unavailable"].includes(failure.error.category) && typeof exactPath === "string" && exactPath) {
        const read = await readFile({ repository, path: exactPath, ...(args.ref ? { ref: args.ref } : {}) });
        return { ...read, label: read.ok ? `Search failed; ${read.label} instead` : read.label, recovery: { attempts, fallback: "read_repository_file", succeeded: read.ok }, content: `${failure.content}\nSearch did not succeed. Direct file fallback ${read.ok ? "succeeded" : "failed"}:\n${read.content}` };
      }
      return { ...failure, recovery: { attempts, succeeded: false } };
    }
    const body = await response.json();
    if (!Array.isArray(body?.items)) return { ok: false, label: "Invalid GitHub search response", content: "GitHub returned no search result array. Try a known file with read_repository_file." };
    // Do not silently omit paths by clipping the response. Long paths advance
    // with an explicit item offset within the same upstream result page.
    const allPaths = body.items.slice(0, perPage).map(item => item?.path).filter(path => typeof path === "string");
    const itemOffset = args.itemOffset ?? 0;
    if (!Number.isSafeInteger(itemOffset) || itemOffset < 0 || itemOffset > allPaths.length) return { ok: false, label: "Invalid search item offset", content: "Use nextItemOffset from the previous search page." };
    const paths = []; let chars = 0;
    for (const path of allPaths.slice(itemOffset)) {
      if (chars + path.length > 6000) break;
      paths.push(path); chars += path.length + 1;
    }
    const nextItemOffset = itemOffset + paths.length < allPaths.length ? itemOffset + paths.length : null;
    const totalCount = Number.isSafeInteger(body.total_count) ? body.total_count : allPaths.length;
    const nextPage = nextItemOffset === null && page * perPage < Math.min(totalCount, 1000) && allPaths.length ? page + 1 : null;
    const metadata = { page, perPage, itemOffset, nextItemOffset, totalCount, nextPage, incomplete: Boolean(body.incomplete_results), capped: totalCount > 1000, query };
    return { ok: true, label: `Searched ${repository} (${paths.length} files, page ${page})`, page: metadata, ...(attempts.length ? { recovery: { attempts, succeeded: true } } : {}), content: asData(`code search in ${repository}`, `Search page: ${JSON.stringify(metadata)}\n${paths.join("\n") || "No matches."}\n${nextItemOffset !== null ? "Continue the same page with nextItemOffset as itemOffset." : nextPage ? "Continue with nextPage and the same query/filters." : "End of accessible results."} REST search indexes the default branch and may omit large/unindexed files; no matches is not proof of absence. Use read_repository_file for a known file or list a focused directory. Narrow with filename/path if capped or incomplete.`) };
  }
}
