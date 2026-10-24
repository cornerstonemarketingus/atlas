import { createHash } from "node:crypto";

import {
  approvalRequestEvent,
  artifactEvent,
  assistantMessageEvent,
  completionEvent,
  errorEvent,
  statusEvent,
  toolExecutionEvent,
  toolProposalEvent,
  validationResultEvent,
} from "./events.mjs";
import { VERIFIER_PROFILE_ID } from "./independent-verifier.mjs";
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
 *
 * In the daemon three more things are wired in, and each closes a way the
 * outcome could otherwise be untrue:
 *
 * - `policy` + `approvals`: running the coder is a `code.write` action. A deny
 *   blocks it before the model is called and says where to allow it; "ask"
 *   files an approval bound to this exact turn and waits for the owner's
 *   decision on the approvals API; a granted approval is spent once.
 * - `verify`: Atlas's own verifier (independent-verifier.mjs) re-runs the
 *   repository's test command in the worktree after the coder exits. The
 *   session is completed only when that run exits 0; the coder's exit code and
 *   the model's prose are never the receipt.
 * - `baseUrl`: the model server the coder talks to, so it is the same local
 *   server the rest of Atlas was pointed at.
 */
export function createLocalExecutor({ runCoder = runIsolatedLocalCoder, dataDirectory, verifyDir, modelPlan = null, baseUrl = undefined, policy = null, approvals = null, verify = null } = {}) {
  return {
    id: "local",
    description: "Runs the coder locally in an isolated Git worktree.",
    // The runtime refuses a session or turn without one before anything runs.
    requiresRepository: true,
    async run({ session, turn, emit, budget, signal, checkpoint }) {
      await checkpoint();
      if (!session.repository) {
        emit(statusEvent("No repository is attached to this session."));
        return { status: "failed", summary: "This session has no repository to work in." };
      }

      const toolCallId = digest(`${session.id}:${turn.id}`).slice(0, 16);
      // Bound to this session, turn, repository and objective: an approval for
      // one coding request cannot be spent on another.
      const actionDigest = digest(JSON.stringify({ tool: "repository.coder", sessionId: session.id, turnId: turn.id, repository: session.repository, objective: turn.text }));
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

      if (policy) {
        const decision = policy("code.write")?.decision ?? "deny";
        if (decision === "deny") {
          const summary = "Blocked by policy: code.write is set to deny, so Atlas did not start the coder. To allow it, open Approvals → Policies in the Atlas console and set code.write to ask or allow (PUT /v1/policies {\"capability\":\"code.write\",\"decision\":\"ask\"}).";
          emit(toolExecutionEvent({ toolCallId, tool: "repository.coder", outcome: "blocked", durationMs: 0, summary, errorCode: "POLICY_DENIED" }));
          emit(errorEvent({ code: "POLICY_DENIED", summary, recoverable: true }));
          return { status: "failed", summary };
        }
        if (decision !== "allow" && !(await approvals?.check?.(actionDigest))) {
          const summary = `Run the coder on ${session.repository}: ${String(turn.text).replace(/\s+/gu, " ").slice(0, 300)}`;
          if (!approvals?.request) {
            const refused = "code.write needs the owner's approval, and no approval inbox is available here.";
            emit(errorEvent({ code: "APPROVAL_UNAVAILABLE", summary: refused, recoverable: false }));
            return { status: "failed", summary: refused };
          }
          const approval = await approvals.request({ digest: actionDigest, capability: "code.write", summary, sessionId: session.id });
          emit(approvalRequestEvent({ approvalId: approval?.id ?? actionDigest, capability: "code.write", summary, actionDigest }));
          emit(toolExecutionEvent({ toolCallId, tool: "repository.coder", outcome: "blocked", durationMs: 0, summary: "Waiting for approval of code.write." }));
          return { status: "awaiting_approval", summary: "The coder needs your approval for code.write before it runs." };
        }
      }

      budget.record({ toolCalls: 1 });
      emit(statusEvent("Creating an isolated worktree and starting the coder."));

      const startedAtMs = Date.now();
      const result = await runCoder(
        { id: `${session.id}-${turn.id}`, repository: session.repository, objective: turn.text, model: session.model },
        { dataDirectory, verifyDir, signal, modelPlan, ...(baseUrl ? { baseUrl } : {}) },
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
      // Where the change (and the verifier's test run) lives, for inspection.
      if (result.worktree) emit(artifactEvent({ name: "worktree", path: result.worktree }));
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
      if (!verify) return { status: result.ok ? "completed" : "failed", summary: result.ok ? "Local run verified." : (result.message ?? "The local run failed.") };

      // Independent verification: what the tests say now, in the worktree the coder left.
      if (!result.worktree) return { status: "failed", summary: `The coder did not run: ${keyLine(result.message) ?? "no worktree was created"}` };
      // Nothing changed and the coder failed: there is nothing to verify, only a cause to report.
      if (!result.ok && !result.patch) return { status: "failed", summary: `The coder failed without changing anything: ${keyLine(result.message) ?? "no reason was reported"}` };
      emit(statusEvent("Atlas is re-running the repository's tests to verify the result."));
      const receipt = await verify({ worktree: result.worktree, verifyDir, signal });
      await checkpoint();
      emit(validationResultEvent({
        profileId: VERIFIER_PROFILE_ID,
        outcome: receipt.status === "verified" ? "passed" : receipt.status,
        summary: receipt.reason,
        failures: receipt.status === "failed" ? [receipt.outputExcerpt.slice(-1_500)] : [],
        evidence: receipt,
      }));
      if (!result.ok) return { status: "failed", summary: `The coder did not finish: ${keyLine(result.message) ?? "it reported a failure"}. Atlas's verifier: ${receipt.reason}` };
      if (receipt.status === "verified") return { status: "completed", verified: true, summary: `Verified by Atlas: ${receipt.reason}` };
      if (receipt.status === "unverified") return { status: "failed", summary: `Unverified: ${receipt.reason} The coder's own report is not accepted as proof.` };
      return { status: "failed", summary: `Verification failed: ${receipt.reason} The coder reported success, but the repository's tests do not pass.` };
    },
  };
}

/** The line of a coder's output that says what went wrong (its error line, else its last line). */
function keyLine(text) {
  const lines = String(text ?? "").split("\n").map((line) => line.trim())
    .filter((line) => line && !/^(Isolated worktree|Portable patch|No patch was produced|at |Node\.js v|\^)/u.test(line));
  return (lines.find((line) => /^Error: /u.test(line))?.replace(/^Error: /u, "") ?? lines.at(-1) ?? null)?.slice(0, 600) ?? null;
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
