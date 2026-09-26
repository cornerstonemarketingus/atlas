const MODES = new Set(["inspect", "debug", "coder"]);
const TRIGGER_TYPES = new Set(["cron", "github-check-failure"]);
const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const branchPattern = /^(?!\/|.*(?:\.\.|\/\/|@\{|\\|\s|[\x5b~^:?*]))[A-Za-z0-9._/-]{1,255}$/u;

export function validateAutomation(body, allowlist) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { error: "Automation payload is required.", status: 400 };
  const repository = typeof body.repository === "string" ? body.repository.toLowerCase() : "";
  const branch = typeof body.branch === "string" ? body.branch : "";
  const mode = typeof body.mode === "string" ? body.mode : "";
  const objective = typeof body.objective === "string" ? body.objective.trim() : "";
  const triggerType = typeof body.triggerType === "string" ? body.triggerType : "";
  const trigger = typeof body.trigger === "object" && body.trigger && !Array.isArray(body.trigger) ? body.trigger : null;
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const budgetLimit = Number.parseInt(String(body.budgetLimit ?? ""), 10);
  const budgetWindowDays = Number.parseInt(String(body.budgetWindowDays ?? ""), 10);
  if (!name || name.length > 100) return { error: "Name is invalid.", status: 400 };
  if (!repositoryPattern.test(repository) || !allowlist.has(repository)) return { error: "That repository is not on your Atlas allowlist.", status: 403 };
  if (!branchPattern.test(branch)) return { error: "Branch name is invalid.", status: 400 };
  if (!MODES.has(mode)) return { error: "Task mode is invalid.", status: 400 };
  if (!objective || objective.length > 4000) return { error: "Objective is invalid.", status: 400 };
  if (!TRIGGER_TYPES.has(triggerType) || !trigger) return { error: "Trigger is invalid.", status: 400 };
  if (!Number.isInteger(budgetLimit) || budgetLimit < 1 || budgetLimit > 1000) return { error: "Budget limit is invalid.", status: 400 };
  if (!Number.isInteger(budgetWindowDays) || budgetWindowDays < 1 || budgetWindowDays > 365) return { error: "Budget window is invalid.", status: 400 };
  if (triggerType === "cron") {
    if (typeof trigger.cron !== "string" || !isValidCron(trigger.cron)) return { error: "Cron expression is invalid.", status: 400 };
  }
  if (triggerType === "github-check-failure") {
    if (typeof trigger.branch !== "string" || !branchPattern.test(trigger.branch)) return { error: "Trigger branch is invalid.", status: 400 };
  }
  return {
    automation: {
      name,
      repository,
      branch,
      mode,
      objective,
      triggerType,
      trigger: triggerType === "cron"
        ? { cron: trigger.cron.trim() }
        : { branch: trigger.branch, checkName: typeof trigger.checkName === "string" ? trigger.checkName.trim() : "" },
      budgetLimit,
      budgetWindowDays,
    },
  };
}

export function isValidCron(cron) {
  const fields = String(cron).trim().split(/\s+/u);
  if (fields.length !== 5) return false;
  return fields.every((field, index) => matchCronField(field, cronDatePartMin(index), cronDatePartMax(index), true));
}

function cronDatePartMin(index) {
  return index === 3 ? 1 : 0;
}
function cronDatePartMax(index) {
  return [59, 23, 31, 12, 6][index];
}

function matchCronField(field, min, max, validateOnly = false, current = 0) {
  if (field === "*") return true;
  for (const part of field.split(",")) {
    const stepSplit = part.split("/");
    const left = stepSplit[0];
    const step = stepSplit[1] === undefined ? 1 : Number.parseInt(stepSplit[1], 10);
    if (!Number.isInteger(step) || step < 1) return false;
    const range = left === "*" ? [min, max]
      : left.includes("-")
        ? left.split("-").map((value) => Number.parseInt(value, 10))
        : [Number.parseInt(left, 10), Number.parseInt(left, 10)];
    if (range.length !== 2 || range.some((value) => !Number.isInteger(value) || value < min || value > max) || range[0] > range[1]) return false;
    if (!validateOnly) {
      const [start, end] = range;
      if (current >= start && current <= end && ((current - start) % step === 0)) return true;
    }
  }
  return validateOnly ? true : false;
}

export function cronMatches(cron, now) {
  const fields = String(cron).trim().split(/\s+/u);
  if (fields.length !== 5) return false;
  const date = now instanceof Date ? now : new Date(now);
  const values = [date.getUTCMinutes(), date.getUTCHours(), date.getUTCDate(), date.getUTCMonth() + 1, date.getUTCDay()];
  return fields.every((field, index) => matchCronField(field, cronDatePartMin(index), cronDatePartMax(index), false, values[index]));
}

export function githubFailureMatches(trigger, event) {
  if (!event || event.kind !== "github.check-failed") return false;
  const branch = String(trigger?.branch ?? "");
  if (!branch || branch !== event.branch) return false;
  const checkName = String(trigger?.checkName ?? "").trim();
  return !checkName || checkName === event.checkName;
}
