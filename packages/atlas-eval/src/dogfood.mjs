import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";

export const OUTCOMES = Object.freeze(["success", "failed", "abandoned"]);
const SECRET = /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|gsk_[A-Za-z0-9]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|Bearer\s+[A-Za-z0-9._-]{20,})/u;
const hash = (line) => createHash("sha256").update(line).digest("hex");

/**
 * One Atlas-on-Atlas task: outcome, failure class, model, tokens and whether a
 * person had to step in. Returns problems; empty means valid. Free text is
 * short and refused if it looks like a credential.
 */
export function validateEntry(entry) {
  const problems = [];
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return ["entry must be an object"];
  if (typeof entry.task !== "string" || entry.task.trim().length < 3 || entry.task.length > 200) problems.push("task must be a 3-200 character reference or title");
  if (!OUTCOMES.includes(entry.outcome)) problems.push(`outcome must be one of ${OUTCOMES.join(", ")}`);
  if (entry.outcome === "success" ? entry.failureClass !== null : !/^[a-z0-9][a-z0-9-]{1,48}$/u.test(entry.failureClass ?? "")) problems.push("failureClass is null on success and a kebab-case slug otherwise");
  if (typeof entry.model !== "string" || entry.model.length === 0 || entry.model.length > 100) problems.push("model is required");
  if (!Number.isInteger(entry.tokens?.input) || !Number.isInteger(entry.tokens?.output) || entry.tokens.input < 0 || entry.tokens.output < 0) problems.push("tokens.input/output must be non-negative integers");
  if (typeof entry.humanIntervention !== "boolean") problems.push("humanIntervention must be true or false");
  if (entry.notes !== undefined && (typeof entry.notes !== "string" || entry.notes.length > 500)) problems.push("notes must be at most 500 characters");
  for (const field of ["task", "model", "notes", "failureClass"]) if (typeof entry[field] === "string" && SECRET.test(entry[field])) problems.push(`${field} looks like a credential`);
  return problems;
}

/** Appends one hash-chained line; refuses invalid entries. Existing lines are never rewritten. */
export async function appendEntry(file, entry, now = new Date()) {
  const problems = validateEntry(entry);
  if (problems.length > 0) throw new Error(`invalid dogfood entry: ${problems.join("; ")}`);
  const existing = await readLog(file);
  const last = existing.at(-1);
  const record = {
    sequence: existing.length + 1, recordedAt: now.toISOString(), previous: last ? hash(last.raw) : null,
    task: entry.task, outcome: entry.outcome, failureClass: entry.failureClass, model: entry.model,
    tokens: { input: entry.tokens.input, output: entry.tokens.output }, humanIntervention: entry.humanIntervention,
    ...(entry.notes ? { notes: entry.notes } : {}),
  };
  const line = JSON.stringify(record);
  await mkdir(dirname(file), { recursive: true });
  await appendFile(file, line + "\n");
  return record;
}

/** Reads and verifies the chain; an edited, removed or reordered line is an error. */
export async function readLog(file) {
  let text;
  try { text = await readFile(file, "utf8"); } catch (error) { if (error.code === "ENOENT") return []; throw error; }
  const entries = [];
  for (const [index, raw] of text.split("\n").filter(Boolean).entries()) {
    let record;
    try { record = JSON.parse(raw); } catch { throw new Error(`dogfood log line ${index + 1} is not JSON`); }
    if (record.sequence !== index + 1) throw new Error(`dogfood log line ${index + 1} is out of sequence`);
    if (record.previous !== (index === 0 ? null : hash(entries[index - 1].raw))) throw new Error(`dogfood log line ${index + 1} does not follow line ${index}: the log was edited`);
    entries.push({ ...record, raw });
  }
  return entries.map(({ raw, ...record }) => Object.defineProperty(record, "raw", { value: raw, enumerable: false }));
}

/** Failure classes seen at least `threshold` times, with the tasks behind them. */
export function recurringFailures(entries, threshold = 3) {
  const groups = new Map();
  for (const entry of entries) {
    if (entry.outcome === "success") continue;
    const group = groups.get(entry.failureClass) ?? { failureClass: entry.failureClass, count: 0, interventions: 0, models: new Set(), tasks: [] };
    group.count++; group.interventions += entry.humanIntervention ? 1 : 0; group.models.add(entry.model); group.tasks.push(entry.task);
    groups.set(entry.failureClass, group);
  }
  return [...groups.values()].filter((group) => group.count >= threshold).map((group) => ({ ...group, models: [...group.models].sort() })).sort((a, b) => b.count - a.count || a.failureClass.localeCompare(b.failureClass));
}

/**
 * A draft eval task skeleton for a recurring failure. It is deliberately not a
 * valid EvalTask: a person supplies the base commit, objective, verify command
 * and solution, then `validate` proves it. Drafts never enter the suite alone.
 */
export function draftTask(group) {
  return {
    draft: true,
    id: `dogfood-${group.failureClass}`,
    category: "TODO: pick one of the eval categories",
    repo: "cornerstonemarketingus/atlas",
    baseCommit: "TODO: parent of the commit that fixed the first failure below",
    objective: `TODO: reproduce the "${group.failureClass}" failure as an instruction a person could implement.`,
    setup: {}, verify: { argv: ["TODO"] }, solution: {}, timeoutMs: 120000,
    tags: ["dogfood", group.failureClass],
    evidence: { occurrences: group.count, humanInterventions: group.interventions, models: group.models, tasks: group.tasks.slice(0, 10) },
  };
}
