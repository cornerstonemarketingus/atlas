export const CATEGORIES = Object.freeze([
  "navigation", "bug-localization", "multi-file-edit", "test-repair",
  "tool-args", "structured-output", "review", "final-synthesis", "browser-reasoning",
  "feature",
]);

export const FAILURE_CLASSES = Object.freeze([
  "tests_failed", "agent_error", "timeout", "no_change", "infra", "quota",
]);

/**
 * A provider refusing for quota (HTTP 429) says nothing about the model, so
 * such a run is classed `quota` and left out of the pass rate.
 */
export const isQuotaRefusal = (text) => /\bHTTP 429\b/u.test(String(text ?? ""));

const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const isRelativePath = (value) =>
  typeof value === "string" && value.length > 0 && !value.startsWith("/") && !/^[A-Za-z]:/u.test(value)
  && !value.split(/[\\/]/u).includes("..");
const isCommit = (value) => typeof value === "string" && /^[0-9a-f]{7,40}$/u.test(value);
const isArgv = (value) => Array.isArray(value) && value.length > 0 && value.every((part) => typeof part === "string" && part.length > 0);

/**
 * EvalTask: the commit's parent plus an objective; `verify` is the tests the
 * commit added or changed. `setup` is applied to the checked-out base before
 * the agent runs (`visible` files the agent may read, e.g. the new tests);
 * `solution` is applied only by dry runs to prove the task is solvable.
 * Returns a list of problems; empty means valid.
 */
export function validateTask(task) {
  const problems = [];
  if (!isObject(task)) return ["task must be an object"];
  if (typeof task.id !== "string" || !/^[a-z0-9][a-z0-9-]*$/u.test(task.id)) problems.push("id must be kebab-case");
  if (!CATEGORIES.includes(task.category)) problems.push(`category must be one of ${CATEGORIES.join(", ")}`);
  if (typeof task.repo !== "string" || task.repo.length === 0) problems.push("repo is required");
  if (!isCommit(task.baseCommit)) problems.push("baseCommit must be a git commit hash");
  if (typeof task.objective !== "string" || task.objective.trim().length < 20) problems.push("objective must be a real instruction (20+ characters)");
  if (!isArgv(task.verify?.argv)) problems.push("verify.argv must be a non-empty argv array (no shell)");
  if (!Number.isInteger(task.timeoutMs) || task.timeoutMs < 1000 || task.timeoutMs > 3_600_000) problems.push("timeoutMs must be 1000..3600000");
  if (!Array.isArray(task.tags) || task.tags.some((tag) => typeof tag !== "string")) problems.push("tags must be strings");
  const setup = task.setup ?? {};
  if (!isObject(setup)) problems.push("setup must be an object");
  else {
    if (setup.fromCommit !== undefined && !isCommit(setup.fromCommit)) problems.push("setup.fromCommit must be a commit hash");
    for (const path of setup.paths ?? []) if (!isRelativePath(path)) problems.push(`setup path escapes the workspace: ${path}`);
    for (const path of Object.keys(setup.files ?? {})) if (!isRelativePath(path)) problems.push(`setup file escapes the workspace: ${path}`);
    if ((setup.paths?.length ?? 0) > 0 && setup.fromCommit === undefined) problems.push("setup.paths needs setup.fromCommit");
  }
  const solution = task.solution;
  if (!isObject(solution)) problems.push("solution is required so dry runs can prove the task is solvable");
  else {
    const hasCommit = solution.fromCommit !== undefined || solution.paths !== undefined;
    const hasFiles = solution.files !== undefined;
    if (!hasCommit && !hasFiles) problems.push("solution needs fromCommit+paths or files");
    if (hasCommit) {
      if (!isCommit(solution.fromCommit)) problems.push("solution.fromCommit must be a commit hash");
      if (!Array.isArray(solution.paths) || solution.paths.length === 0) problems.push("solution.paths must list the files the fix changes");
    }
    for (const path of [...(solution.paths ?? []), ...Object.keys(solution.files ?? {})]) if (!isRelativePath(path)) problems.push(`solution path escapes the workspace: ${path}`);
    for (const path of setup.paths ?? []) if ((solution.paths ?? []).includes(path)) problems.push(`path is both visible setup and solution: ${path}`);
  }
  return problems;
}

export function validateResult(result) {
  const problems = [];
  if (!isObject(result)) return ["result must be an object"];
  if (typeof result.taskId !== "string") problems.push("taskId");
  if (typeof result.target !== "string") problems.push("target");
  if (typeof result.passed !== "boolean") problems.push("passed");
  if (typeof result.verified !== "boolean") problems.push("verified");
  if (result.passed && !result.verified) problems.push("passed requires verified");
  for (const key of ["toolCalls", "toolErrors", "repairs", "latencyMs"]) {
    if (!Number.isInteger(result[key]) || result[key] < 0) problems.push(key);
  }
  if (result.ttftMs !== null && !(Number.isFinite(result.ttftMs) && result.ttftMs >= 0)) problems.push("ttftMs");
  if (!isObject(result.tokens) || !Number.isInteger(result.tokens.input) || !Number.isInteger(result.tokens.output)) problems.push("tokens");
  if (result.costUsd !== null && !(Number.isFinite(result.costUsd) && result.costUsd >= 0)) problems.push("costUsd");
  if (result.failureClass !== null && !FAILURE_CLASSES.includes(result.failureClass)) problems.push("failureClass");
  if (result.passed && result.failureClass !== null) problems.push("a pass has no failureClass");
  if (!result.passed && result.failureClass === null) problems.push("a failure needs a failureClass");
  if (!isObject(result.evidence)) problems.push("evidence");
  return problems;
}
