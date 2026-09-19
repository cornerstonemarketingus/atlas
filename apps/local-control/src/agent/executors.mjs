import { createHash } from "node:crypto";

import {
  artifactEvent,
  assistantMessageEvent,
  completionEvent,
  statusEvent,
  toolExecutionEvent,
  toolProposalEvent,
  validationResultEvent,
} from "./events.mjs";
import { runIsolatedLocalCoder } from "../runner.mjs";

/**
 * Executors are adapters. The runtime knows nothing about worktrees, GitHub,
 * or hosted browsers — it knows how to lease a session, stream its events,
 * and stop it. Everything vendor-specific lives behind this one shape:
 *
 *   run({ session, turn, history, emit, budget, signal, checkpoint })
 *     -> { status, summary }
 */

/**
 * The default. Runs the coder against an isolated Git worktree on this
 * machine, with no network dependency beyond the model endpoint the operator
 * configured — which may itself be loopback Ollama.
 */
export function createLocalExecutor({ runCoder = runIsolatedLocalCoder, dataDirectory, verifyDir } = {}) {
  return {
    id: "local",
    description: "Runs the coder locally in an isolated Git worktree.",
    async run({ session, turn, emit, budget, signal, checkpoint }) {
      await checkpoint();
      if (!session.repository) {
        emit(statusEvent("No repository is attached to this session."));
        return { status: "failed", summary: "This session has no repository to work in." };
      }

      const toolCallId = digest(`${session.id}:${turn.id}`).slice(0, 16);
      budget.record({ toolCalls: 1 });
      emit(
        toolProposalEvent({
          toolCallId,
          tool: "repository.coder",
          capability: "code.write",
          risk: "moderate",
          argumentsDigest: digest(`${session.repository}\n${turn.text}`),
          summary: `Work on ${session.repository} in an isolated worktree.`,
        }),
      );
      emit(statusEvent("Creating an isolated worktree and starting the coder."));

      const startedAtMs = Date.now();
      const result = await runCoder(
        { id: `${session.id}-${turn.id}`, repository: session.repository, objective: turn.text, model: session.model },
        { dataDirectory, verifyDir, signal },
      );
      const durationMs = Date.now() - startedAtMs;

      emit(
        toolExecutionEvent({
          toolCallId,
          tool: "repository.coder",
          outcome: result.cancelled ? "cancelled" : result.ok ? "succeeded" : "failed",
          durationMs,
          summary: result.message ?? "",
        }),
      );
      if (result.patch) {
        emit(artifactEvent({ name: "patch", path: result.patch, bytes: result.patchBytes ?? null }));
      }
      emit(
        validationResultEvent({
          profileId: "local-coder",
          outcome: result.ok ? "passed" : result.cancelled ? "cancelled" : "failed",
          summary: result.ok ? "The local coder completed its verification pass." : (result.message ?? "The local coder did not verify."),
        }),
      );

      // A cancelled child is the operator's decision, not an executor error:
      // surface the checkpoint so the runtime reports it as a cancellation.
      await checkpoint();

      emit(assistantMessageEvent({ text: result.message ?? "", final: true, turnId: turn.id }));
      return { status: result.ok ? "completed" : "failed", summary: result.ok ? "Local run verified." : (result.message ?? "The local run failed.") };
    },
  };
}

/**
 * GitHub Actions, demoted to an option.
 *
 * This is the path Atlas used to be built around. It still works, and for a
 * machine that is asleep it is genuinely useful — but it is now selected per
 * session, it is not installed unless credentials exist, and nothing in the
 * runtime depends on it. `dispatch` and `poll` are injected so the adapter
 * carries no credential of its own: the caller supplies a bound client.
 */
export function createGitHubActionsExecutor({ dispatch, poll, pollIntervalMs = 15_000 } = {}) {
  return {
    id: "github-actions",
    description: "Dispatches the coder to GitHub Actions and streams its status back.",
    async run({ session, turn, emit, budget, signal, checkpoint }) {
      await checkpoint();
      if (typeof dispatch !== "function" || typeof poll !== "function") {
        // Fail closed and say why. An unconfigured remote executor must never
        // look like a transient error the operator should wait out.
        emit(statusEvent("The GitHub Actions executor is not configured on this machine."));
        return {
          status: "failed",
          summary: "GitHub Actions execution is not configured. Add a GitHub token to this profile or run the session locally.",
        };
      }

      budget.record({ toolCalls: 1 });
      emit(statusEvent("Dispatching the coder workflow to GitHub Actions."));
      const run = await dispatch({ repository: session.repository, objective: turn.text, model: session.model, signal });
      emit(
        toolExecutionEvent({
          toolCallId: digest(`${session.id}:${turn.id}`).slice(0, 16),
          tool: "github.workflow_dispatch",
          outcome: "succeeded",
          durationMs: 0,
          summary: `Dispatched run ${run.id}.`,
        }),
      );

      let status = run.status;
      while (status !== "completed" && status !== "failed" && status !== "cancelled") {
        await checkpoint();
        await delay(pollIntervalMs, signal);
        await checkpoint();
        const latest = await poll({ id: run.id, signal });
        if (latest.status !== status) emit(statusEvent(`Remote run is ${latest.status}.`, { runId: run.id }));
        status = latest.status;
        if (latest.url) emit(artifactEvent({ name: "workflow-run", path: latest.url }));
      }

      emit(completionEvent({ status, summary: `Remote run ${run.id} finished as ${status}.` }));
      return { status: status === "completed" ? "completed" : "failed", summary: `Remote run ${run.id} finished as ${status}.` };
    },
  };
}

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error("Aborted."));
    const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
    function onAbort() { clearTimeout(timer); reject(signal.reason ?? new Error("Aborted.")); }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}
