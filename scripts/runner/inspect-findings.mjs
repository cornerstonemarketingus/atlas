import { spawnSync } from "node:child_process";

/**
 * Answers the marker questions an inspection can actually answer.
 *
 * `inspect` mode is deterministic and model-free: it reads a repository and
 * returns an inventory (files, languages, frameworks, manifests). It used to
 * ignore the objective entirely, so "list every TODO comment" came back as an
 * inventory under a green "completed" with nothing to say it had not been
 * answered. This module recognises the one family of questions that a plain
 * text search settles exactly (comment markers such as TODO/FIXME), answers
 * them with file, line and text, and leaves everything else to be reported as
 * unanswered rather than implied done.
 */

const MARKERS = ["TODO", "FIXME", "HACK", "XXX"];
export const MAX_STORED_MATCHES = 500;
export const MAX_SHOWN_MATCHES = 80;
const MAX_TEXT_CHARACTERS = 200;

/** Markers the objective names, in canonical order; empty when it names none. */
export function requestedMarkers(objective) {
  const named = new Set([...String(objective ?? "").matchAll(/\b(todo|fixme|hack|xxx)s?\b/giu)].map((match) => match[1].toUpperCase()));
  return MARKERS.filter((marker) => named.has(marker));
}

/** A marker counts only as a comment, so a mention such as "see TODO.md" or a string literal is not a finding. */
export function markerPattern(markers) {
  return `(//|#|/\\*|\\*|<!--|--)[[:space:]]*(${markers.join("|")})([^A-Za-z0-9_.]|$)`;
}

const EXCLUDED = ["*.lock", "package-lock.json", "**/node_modules/**", "**/dist/**", "**/.next/**", "**/vendor/**"];

/**
 * Bounded text search over the checked-out tree. Git runs with hooks and
 * filesystem monitors off because the tree is untrusted data.
 */
export function findMarkers(root, markers, { run = spawnSync } = {}) {
  const result = run("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-C", root, "--no-pager", "grep",
    "-n", "-I", "-E", "--no-color", "-e", markerPattern(markers), "--", ".", ...EXCLUDED.map((glob) => `:(exclude,glob)${glob}`)],
  { encoding: "utf8", timeout: 60_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true });
  // git grep exits 1 when nothing matched, which is an answer, not a failure.
  if (result.error || (result.status !== 0 && result.status !== 1)) {
    return { markers, ok: false, error: `The marker search did not run (${result.error?.code ?? `git exit ${result.status}`}).`, total: 0, files: 0, matches: [], truncated: false };
  }
  const matches = [];
  const files = new Set();
  let total = 0;
  for (const raw of (result.stdout ?? "").split("\n")) {
    const parsed = /^(.+?):(\d+):(.*)$/u.exec(raw);
    if (parsed === null) continue;
    total += 1;
    files.add(parsed[1]);
    if (matches.length < MAX_STORED_MATCHES) matches.push({ path: parsed[1], line: Number(parsed[2]), text: parsed[3].trim().slice(0, MAX_TEXT_CHARACTERS) });
  }
  return { markers, ok: true, total, files: files.size, matches, truncated: total > matches.length };
}

/** Plain text for the chat reply: the count first, then path:line and the comment. */
export function renderFindings(findings) {
  const names = findings.markers.join("/");
  if (findings.total === 0) return [`Searched the checked-out tree for ${names} comments: none found.`];
  const shown = findings.matches.slice(0, MAX_SHOWN_MATCHES);
  return [
    `Found ${findings.total} ${names} comment${findings.total === 1 ? "" : "s"} in ${findings.files} file${findings.files === 1 ? "" : "s"}${shown.length < findings.total ? ` (showing the first ${shown.length}; the full list of up to ${MAX_STORED_MATCHES} is in the findings.json artifact)` : ""}:`,
    ...shown.map((match) => `${match.path}:${match.line}  ${match.text}`),
  ];
}

export function renderUnanswered(objective) {
  const asked = String(objective ?? "").replace(/\s+/gu, " ").trim().slice(0, 200);
  return `This inspection produced a repository inventory only; it cannot search for or explain specific code.${asked ? ` If you asked for something specific ("${asked}"), it was not answered.` : ""} Ask Atlas to look at that directly, or start a coder run to investigate it.`;
}
