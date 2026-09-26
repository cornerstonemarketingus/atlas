/**
 * Routing by task difficulty: small models for small jobs, the strongest
 * model for hard ones, and escalation when a cheaper attempt already failed.
 *
 * Difficulty is judged from what is known before any model runs — the kind
 * of task, how many files it names, and words that signal breadth — so the
 * choice is explainable and repeatable. A retry always escalates: repeating
 * the same model on the same problem mostly repeats the same mistake.
 */

const HARD_WORDS = /\b(refactor|architecture|redesign|migrat\w*|concurren\w*|race condition|security|performance|across (the )?(code|repo)|multiple (files|modules)|protocol)\b/iu;
const SIMPLE_WORDS = /\b(typo|rename|comment|docs?|documentation|readme|log message|wording|lint|format)\b/iu;
const PATH_LIKE = /[\w.-]+\/[\w./-]+\.[a-z]{1,5}\b/giu;

/** @returns {{ level: "simple"|"standard"|"hard", reasons: string[] }} */
export function classifyDifficulty({ objective = "", kind = "", attempt = 1 } = {}) {
  const reasons = [];
  const files = new Set(String(objective).match(PATH_LIKE) ?? []);
  let level = "standard";
  if (kind === "failing-check") reasons.push("a failing check needs diagnosis");
  if (kind === "todo-comment" && files.size <= 1) { level = "simple"; reasons.push("one local TODO"); }
  if (SIMPLE_WORDS.test(objective) && files.size <= 1) { level = "simple"; reasons.push("wording-level change"); }
  if (HARD_WORDS.test(objective)) { level = "hard"; reasons.push("broad or risky change"); }
  if (files.size >= 3) { level = "hard"; reasons.push(`${files.size} files named`); }
  if (attempt >= 2) { level = "hard"; reasons.push(`attempt ${attempt}: escalating after a failure`); }
  return { level, reasons };
}

/**
 * Picks a model tag from a plan (catalog.planModels) for a difficulty level.
 * simple → fast, standard → coder, hard → the stronger of coder/reviewer
 * that can use tools (the coder by construction). Falls back to `fallback`.
 */
export function modelForDifficulty(plan, level, fallback = null) {
  const pick = level === "simple" ? plan?.fast ?? plan?.coder : plan?.coder;
  const usable = pick && pick.installed !== false ? pick : [plan?.coder, plan?.fast].find((entry) => entry && entry.installed !== false);
  return usable ? { tag: usable.tag, context: usable.context } : fallback;
}
