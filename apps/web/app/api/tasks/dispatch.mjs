import { isCorrelationId } from "./correlation.mjs";

const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const branchPattern = /^(?!\/|.*(?:\.\.|\/\/|@\{|\\|\s|[\x5b~^:?*]))[A-Za-z0-9._/-]{1,255}$/;
const workflowPattern = /^(?:[A-Za-z0-9_.-]{1,128}|[1-9][0-9]{0,18})$/;
const modes = new Set(["inspect", "debug", "coder"]);

export function allowedRepositories(value = "cornerstonemarketingus/atlas") {
  return new Set(value.split(",").map((item) => item.trim().toLowerCase()).filter(Boolean));
}

export function validateTask(body, allowlist) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { error: "A task payload is required.", status: 400 };
  const { repository, branch, mode, objective } = body;
  if (typeof repository !== "string" || !repositoryPattern.test(repository) || !allowlist.has(repository.toLowerCase())) {
    return { error: "That repository is not on your Atlas allowlist.", status: 403 };
  }
  if (typeof branch !== "string" || !branchPattern.test(branch)) return { error: "Branch name is invalid.", status: 400 };
  if (typeof mode !== "string" || !modes.has(mode)) return { error: "Task mode is invalid.", status: 400 };
  if (typeof objective !== "string" || !objective.trim() || objective.length > 4_000) return { error: "Objective is invalid.", status: 400 };
  if (mode === "coder") {
    const assessment = assessCoderObjective(objective);
    if (!assessment.ok) return { error: assessment.reason, status: 422, needsClarification: true };
  }
  return { task: { repository: repository.toLowerCase(), branch, mode, objective: objective.trim() } };
}

const LEAD_IN = /^(?:(?:hey|hi|hello|yo|ok(?:ay)?|so|atlas)[,!.:\s]+)*/iu;
const CONVERSATIONAL = /^(?:can|could|would|will)\s+(?:you|u)\b|^(?:what|why|how|is|are|do|does|should)\b/iu;
/** Something concrete to change: a file, a path, an identifier, or a named part of a product. */
const CONCRETE_TARGET = new RegExp([
  String.raw`\b[\w-]+\.[a-z]{1,5}\b`,
  String.raw`\b[\w.-]+\/[\w./-]+`,
  "`[^`]+`",
  String.raw`\b(?:page|screen|button|link|form|field|input|modal|dialog|menu|nav(?:bar)?|header|footer|sidebar|layout|style|css|theme|dark mode|component|function|method|class|module|endpoint|route|api|query|schema|table|migration|test|tests|spec|lint|type(?:s|script)?|build|script|workflow|dependency|package|readme|docs?|documentation|log(?:s|ging)?|login|log[- ]?in|sign[- ]?(?:in|up)|signup|checkout|cart|dashboard|settings|profile|search|upload|download|email|notification|error|bug|crash|exception|timeout|leak|regression|warning|message|copy|text|label|title|icon|image|chart|report|export|import|cache|retry|config(?:uration)?|env(?:ironment)? var(?:iable)?s?|secret|permission|auth(?:entication|orization)?|token|session|webhook|cron|job|queue|worker)\b`,
].join("|"), "iu");

/**
 * A coding run is bounded and expensive; an objective with nothing concrete
 * to change sends the agent exploring until its turn budget runs out (see
 * docs/atlas-os/RECOVERY.md §1 — "hi can u debug yourself?"). Such an
 * objective is sent back with a request for the missing detail instead.
 * Read-only modes (inspect, debug) stay open-ended on purpose.
 */
export function assessCoderObjective(objective) {
  const text = String(objective ?? "").trim();
  const body = text.replace(LEAD_IN, "");
  const words = body.split(/\s+/u).filter(Boolean);
  const concrete = CONCRETE_TARGET.test(text);
  const reason = "Atlas needs a concrete change to make. Say which part of the project and what should be different when it is done — for example “Fix the login form so an empty password shows an error”. To explore first, ask in chat or start a review.";
  if (words.length < 4) return { ok: false, reason };
  if (!concrete && (CONVERSATIONAL.test(body) || text.includes("?"))) return { ok: false, reason };
  return { ok: true };
}

/**
 * coder tasks run in a separate workflow (atlas-coder.yml) with elevated
 * contents/pull-requests permissions; inspect and debug stay on the
 * read-only-permissioned atlas-runner.yml. Keeping them apart means
 * inspect/debug's GITHUB_TOKEN never gains write scope it doesn't need.
 */
export function workflowForMode(mode, overrides = {}) {
  if (mode === "coder") return overrides.coderWorkflow || "atlas-coder.yml";
  return overrides.defaultWorkflow || "atlas-runner.yml";
}

/**
 * Workflows known to declare the optional `correlation_id` input. GitHub's
 * dispatch API rejects inputs a workflow does not declare, so a custom
 * ATLAS_GITHUB_WORKFLOW / ATLAS_CODER_WORKFLOW override is never sent one.
 */
const CORRELATION_AWARE_WORKFLOWS = new Set(["atlas-runner.yml", "atlas-coder.yml"]);

export function githubDispatchRequest({ token, workflow = "atlas-runner.yml", workflowRef = "main", task, taskId, mergePolicy = "manual", correlationId }) {
  if (!workflowPattern.test(workflow)) throw new Error("ATLAS_GITHUB_WORKFLOW is invalid.");
  if (workflowRef !== "main") throw new Error("ATLAS_RUNNER_WORKFLOW_REF must be 'main'.");
  const [owner, repo] = task.repository.split("/");
  return {
    url: `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`,
    init: {
      method: "POST",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "user-agent": "atlas-control-plane",
        "x-github-api-version": "2022-11-28",
      },
      body: JSON.stringify({
        // The workflow definition must always come from the protected, trusted
        // default branch. The requested branch is passed only as runner input.
        ref: workflowRef,
        inputs: {
          repository: task.repository,
          branch: task.branch,
          mode: task.mode,
          objective: task.objective,
          task_id: taskId,
          // atlas-runner.yml (inspect/debug) doesn't declare this input, and
          // it's untested whether GitHub's dispatch API tolerates an
          // undeclared input key rather than rejecting the whole call — only
          // send it for coder, the one workflow that declares and uses it.
          ...(task.mode === "coder" ? { merge_policy: mergePolicy } : {}),
          // Only a well-formed id, and only to a workflow that declares the
          // input; otherwise it is omitted and the workflow's '' default applies.
          ...(isCorrelationId(correlationId) && CORRELATION_AWARE_WORKFLOWS.has(workflow) ? { correlation_id: correlationId } : {}),
        },
      }),
    },
  };
}

export async function dispatchGitHub(options, fetcher = fetch) {
  const request = githubDispatchRequest(options);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    return await fetcher(request.url, { ...request.init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}
