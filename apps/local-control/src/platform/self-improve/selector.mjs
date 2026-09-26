import { createHash } from "node:crypto";
import { forbiddenPathChanges } from "../engineering/review.mjs";
import { FORBIDDEN_PATHS, isTestFile } from "./policy.mjs";

/**
 * Chooses the next self-improvement: one small, checkable change, with the
 * reason recorded. Deterministic on purpose, so the choice can be audited
 * and repeated: the same repository state and history pick the same task.
 *
 * Candidates, highest value first:
 *   1. failing checks at baseline (the repository is broken; fix that first);
 *   2. TODO / FIXME / HACK comments in source files Atlas may change;
 *   3. unchecked items in TODO.md marked `(self)` — the owner's way of saying
 *      "Atlas may pick this up on its own".
 * Anything in a forbidden path is dropped (the policy would reject the change
 * anyway), and a candidate that already failed MAX_TRIES times is skipped so
 * a hard problem cannot starve the rest of the backlog.
 */

export const MAX_TRIES = 2;
const TODO_COMMENT = /(?:\/\/|#|\/\*|\*)\s*(TODO|FIXME|HACK)\b[:\s-]*(.{8,200})/u;
const SOURCE_FILE = /\.(?:[cm]?js|tsx?|jsx|py|go|rs)$/u;

export function candidateId(kind, key) {
  return `${kind}-${createHash("sha256").update(`${kind}\0${key}`).digest("hex").slice(0, 12)}`;
}

/** Candidates from failing baseline checks: `{ kind, reasons, output }[]`. */
export function failingCheckCandidates(checks = []) {
  return checks.filter((check) => !check.passed).map((check) => ({
    id: candidateId("check", check.kind),
    kind: "failing-check",
    score: 100,
    objective: `The repository's ${check.kind} check fails (${check.reasons.join("; ")}). Find the root cause and fix it so the check passes. Do not disable, skip or weaken any test.`,
    rationale: `The ${check.kind} check is failing at baseline, so every other change would be unverifiable until it is fixed.`,
    evidence: String(check.output ?? "").slice(-1500),
    paths: [],
  }));
}

/**
 * Candidates from TODO-style comments. `files` is `{ path, text }[]` of
 * tracked source files. Test files are skipped (a TODO in a test is rarely a
 * self-contained improvement).
 */
export function todoCommentCandidates(files = []) {
  const candidates = [];
  for (const { path, text } of files) {
    if (!SOURCE_FILE.test(path) || isTestFile(path) || forbiddenPathChanges([path], FORBIDDEN_PATHS).length) continue;
    const lines = String(text ?? "").split("\n");
    lines.forEach((line, index) => {
      const match = TODO_COMMENT.exec(line);
      if (!match) return;
      const note = match[2].replace(/\*\/\s*$/u, "").trim();
      candidates.push({
        id: candidateId("todo", `${path}:${note}`),
        kind: "todo-comment",
        score: match[1] === "FIXME" ? 60 : 50,
        objective: `In ${path} (around line ${index + 1}) there is a ${match[1]}: "${note}". Resolve it with the smallest correct change, add or update a test that shows it works, and remove the comment.`,
        rationale: `A ${match[1]} left in ${path} names a concrete, local improvement.`,
        evidence: lines.slice(Math.max(0, index - 3), index + 4).join("\n"),
        paths: [path],
      });
    });
  }
  return candidates;
}

/** Candidates from `- [ ] ... (self)` items in TODO.md. */
export function backlogCandidates(todoMarkdown = "") {
  const candidates = [];
  for (const line of String(todoMarkdown).split("\n")) {
    const match = /^\s*-\s\[ \]\s+(.+?)\s*\(self\)\s*$/iu.exec(line);
    if (!match) continue;
    candidates.push({
      id: candidateId("backlog", match[1]),
      kind: "backlog",
      score: 20,
      objective: `${match[1]} Keep the change small (a few files), add tests, and tick the item in TODO.md.`,
      rationale: "The owner marked this backlog item as one Atlas may take on by itself.",
      evidence: line.trim(),
      paths: [],
    });
  }
  return candidates;
}

/**
 * Picks one candidate. `history` is the ledger: `{ candidateId, outcome }[]`.
 * Accepted candidates are never picked again; failed ones up to MAX_TRIES.
 * Ties break on id so the choice is stable.
 */
export function selectTask(candidates, history = []) {
  const tries = new Map();
  const done = new Set();
  for (const entry of history) {
    if (!entry?.candidateId) continue;
    if (entry.outcome === "accepted") done.add(entry.candidateId);
    else tries.set(entry.candidateId, (tries.get(entry.candidateId) ?? 0) + 1);
  }
  const eligible = candidates.filter((candidate) => !done.has(candidate.id) && (tries.get(candidate.id) ?? 0) < MAX_TRIES);
  eligible.sort((a, b) => b.score - a.score || (tries.get(a.id) ?? 0) - (tries.get(b.id) ?? 0) || a.id.localeCompare(b.id));
  const chosen = eligible[0] ?? null;
  if (!chosen) return { task: null, reason: candidates.length ? "Every candidate was already done or has failed too often." : "No candidates: the checks pass and there are no eligible TODOs." };
  const attempt = (tries.get(chosen.id) ?? 0) + 1;
  return { task: { ...chosen, attempt }, reason: `${chosen.rationale} (${chosen.kind}, score ${chosen.score}, attempt ${attempt} of ${MAX_TRIES}; ${eligible.length - 1} other candidate(s) waiting).` };
}
