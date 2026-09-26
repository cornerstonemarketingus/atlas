/**
 * What Atlas knows about itself, and the one action chat can take.
 *
 * A chat model knows nothing about the product it is embedded in. Asked to
 * "work on yourself", a bare model answers with a generic twelve-step plan
 * for "the app" and asks which linter to use — because nobody told it that it
 * *is* Atlas, that Atlas has a repository, or that it can start real work on
 * that repository. This module supplies both: a factual self-description,
 * and a tool the model calls to start a coder, inspect or debug run through
 * the same /api/tasks path the task composer uses, with the same allowlist,
 * owner-only self-modification rule, billing and merge policy.
 */

export const SELF_REPOSITORY = "cornerstonemarketingus/atlas";

export const TASK_TOOL_NAME = "start_atlas_task";

const ARCHITECTURE = [
  "Your own source code lives in the GitHub repository cornerstonemarketingus/atlas. Its main parts:",
  "- apps/web: this hosted app (chat, task composer, projects, billing), a React app built with vinext and deployed as a Cloudflare Worker with a D1 database. Changes merged to main under apps/web deploy to production automatically.",
  "- apps/local-control: the local Atlas daemon (zero-dependency Node 22, node:sqlite). It runs the agent runtime, missions of parallel child agents in adaptive batches, the platform task store, policy engine, budgets, authorized tool executor, agent family graph, scoped memory, MCP gateway, terminal controller, skills registry and engineering workflow.",
  "- apps/browser-worker: disposable Playwright/Chromium browser sessions confined to allowed origins.",
  "- apps/windows-companion and mobile/: the desktop companion and the Capacitor mobile shell.",
  "- packages/atlas-cli: the TypeScript CLI and coder agent (repository inspection, change sets, validation). packages/atlas-contracts: shared versioned contracts.",
  "- scripts/runner and .github/workflows: the Atlas Coder workflow that edits a branch, runs the repository's checks before and after, opens a pull request, and merges it itself once every CI check passes (ci-gated autopilot); atlas-runner for inspect/debug; a daily self-improvement run; CI.",
  "- docs/atlas-os: the audit, architecture, security review, backlog and parallel workstream plan. TODO.md holds the self-improvement backlog.",
].join("\n");

export function atlasSystemPrompt({ isOwner = false, repository = "" } = {}) {
  const selected = repository && repository !== SELF_REPOSITORY ? ` The project currently selected in the interface is ${repository}.` : "";
  const selfWork = isOwner
    ? "The person talking to you is the Atlas deployment owner, so you may start work on your own repository."
    : "Only the Atlas deployment owner may start work on Atlas's own repository; for anyone else, offer to work on their connected project instead.";
  return [
    "You are Atlas: an AI software engineering agent and the product this person is using right now. When someone says \"you\", \"yourself\", \"this app\" or \"Atlas\", they mean you and your own codebase, not a hypothetical app.",
    ARCHITECTURE,
    "You can act, not just advise. To change code, investigate, or debug, call the start_atlas_task tool. It starts a real run on GitHub: mode \"coder\" edits code, verifies it, and opens a pull request that merges itself once CI passes; \"inspect\" reads the repository and reports; \"debug\" runs its checks and finds what fails.",
    `To work on yourself, call start_atlas_task with repository "${SELF_REPOSITORY}". ${selfWork}${selected}`,
    "When the person asks you to build, fix, improve, audit or work on something, start the task instead of writing a generic plan for them to carry out. Write the objective as one concrete, checkable change grounded in the parts of the codebase above (name the app, module or file area). If the request is broad, like \"work on yourself\", pick the single most valuable concrete change you can justify, say which one and why in one sentence, and start it. Split large requests into one task per concrete change.",
    "Answer questions about yourself from the facts above. Do not invent files, features, metrics or results. Never claim a task ran, passed, merged or deployed unless the conversation contains that result; after starting a task, say it has started and that its outcome will appear in Tasks.",
    "Be direct and brief; use Markdown for lists and code. No filler, no day-by-day timelines, no asking which generic tools to use.",
  ].join("\n\n");
}

/** OpenAI-compatible tool definition for starting an Atlas run. */
export const TASK_TOOL = {
  type: "function",
  function: {
    name: TASK_TOOL_NAME,
    description: "Start a real Atlas run on a GitHub repository. coder: change code, verify it, open a pull request that merges itself when CI passes. inspect: read the repository and report. debug: run its checks and find what is failing.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["mode", "objective"],
      properties: {
        mode: { type: "string", enum: ["coder", "inspect", "debug"] },
        objective: { type: "string", description: "One concrete, checkable goal, naming the part of the codebase it concerns. At most 4000 characters." },
        repository: { type: "string", description: `owner/name. Use "${SELF_REPOSITORY}" to work on Atlas itself. Defaults to the selected project, or Atlas itself when none is selected.` },
      },
    },
  },
};

/**
 * Pulls start_atlas_task calls out of a chat-completions response and turns
 * each into a validated task request. Malformed calls are reported, never
 * guessed at.
 * @returns {{ requests: { mode: string, objective: string, repository: string }[], errors: string[] }}
 */
export function taskRequestsFrom(payload, options = {}) {
  return taskRequestsFromCalls(payload?.choices?.[0]?.message?.tool_calls, options);
}

/** The same, for tool calls already assembled from a streamed reply. */
export function taskRequestsFromCalls(calls, { defaultRepository = "" } = {}) {
  const requests = [];
  const errors = [];
  if (!Array.isArray(calls)) return { requests, errors };
  for (const call of calls.slice(0, 3)) {
    if (call?.function?.name !== TASK_TOOL_NAME) {
      errors.push(`Ignored an unknown tool '${String(call?.function?.name ?? "")}'.`);
      continue;
    }
    let args;
    try {
      args = typeof call.function.arguments === "string" ? JSON.parse(call.function.arguments || "{}") : (call.function.arguments ?? {});
    } catch {
      errors.push("A task request had unreadable arguments.");
      continue;
    }
    const mode = ["coder", "inspect", "debug"].includes(args?.mode) ? args.mode : null;
    const objective = typeof args?.objective === "string" ? args.objective.trim().slice(0, 4000) : "";
    const repository = (typeof args?.repository === "string" && args.repository.trim()) || defaultRepository || SELF_REPOSITORY;
    if (!mode || !objective) {
      errors.push("A task request was missing its mode or objective.");
      continue;
    }
    requests.push({ mode, objective, repository: repository.trim().toLowerCase() });
  }
  return { requests, errors };
}

/** A short, honest line describing what happened to one requested run. */
export function describeStartedTask(request, outcome) {
  const what = request.mode === "coder" ? "a coder run" : request.mode === "inspect" ? "an inspection" : "a debug run";
  if (!outcome.ok) return `I could not start ${what} on ${request.repository}: ${outcome.message}`;
  const merge = request.mode === "coder"
    ? outcome.mergePolicy === "ci-gated"
      ? " It will open a pull request and merge it itself once every CI check passes."
      : outcome.mergePolicy === "none"
        ? " It will open a pull request and merge it immediately."
        : " It will open a pull request for your review."
    : "";
  return `Started ${what} on ${request.repository}: "${request.objective}".${merge} Follow it in Tasks${outcome.taskId ? ` (task ${outcome.taskId})` : ""}.`;
}
