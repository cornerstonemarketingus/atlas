import { git } from "./git.mjs";
import { isQuotaRefusal, validateResult, validateTask } from "./task.mjs";
import { createWorkspace } from "./workspace.mjs";
import { runVerify } from "./verify.mjs";

const VERIFY_CAP_MS = 300_000;
const emptyOutcome = { toolCalls: 0, toolErrors: 0, repairs: 0, ttftMs: null, tokens: { input: 0, output: 0 }, costUsd: null };

function withDeadline(promise, ms, controller) {
  let timer;
  const deadline = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(Object.assign(new Error("agent deadline"), { code: "AGENT_TIMEOUT" })); }, ms); });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

/**
 * Runs one task against one agent and returns an EvalResult. A task passes
 * only when its own verify command exits 0 on a workspace whose agent-made
 * changes are non-empty; the agent's own report never counts.
 *
 * `agent({ root, objective, task, target, signal })` resolves to the
 * measured fields of an EvalResult (tool calls, tokens, ...) and may throw.
 */
export async function runTask({ task, target, agent, repoRoot }) {
  const problems = validateTask(task);
  if (problems.length > 0) throw new Error(`invalid task ${task?.id ?? "?"}: ${problems.join("; ")}`);
  const started = Date.now();
  let workspace;
  const evidence = {};
  let outcome = emptyOutcome;
  let failureClass = null;
  let verified = false;
  let passed = false;
  try {
    workspace = await createWorkspace({ repoRoot, baseCommit: task.baseCommit });
    const setup = task.setup ?? {};
    if (setup.paths?.length) await workspace.applyPaths(setup.fromCommit, setup.paths);
    if (setup.files) await workspace.writeFiles(setup.files);
    await git(workspace.root, ["add", "-A"]);
    await git(workspace.root, ["-c", "user.name=atlas-eval", "-c", "user.email=eval@invalid", "commit", "--allow-empty", "--no-verify", "-q", "-m", "eval setup"]);
    const baseline = (await git(workspace.root, ["rev-parse", "HEAD"])).trim();

    const controller = new AbortController();
    try {
      outcome = { ...emptyOutcome, ...(await withDeadline(agent({ root: workspace.root, objective: task.objective, task, target, signal: controller.signal }), task.timeoutMs, controller)) };
    } catch (error) {
      failureClass = error?.code === "AGENT_TIMEOUT" ? "timeout" : "agent_error";
      evidence.agentError = String(error?.message ?? error).slice(0, 500);
    }
    evidence.agentStatus = outcome.status ?? null;
    if (outcome.message) evidence.agentMessage = String(outcome.message).slice(0, 500);

    const changed = await workspace.changedPaths(baseline);
    evidence.changedPaths = changed.slice(0, 50);
    const argv = task.verify.argv.map((part) => part.replaceAll("{workspace}", workspace.root).replaceAll("{repo}", repoRoot));
    const verify = await runVerify({ argv, cwd: workspace.root, timeoutMs: Math.min(task.timeoutMs, VERIFY_CAP_MS) });
    evidence.verify = { exitCode: verify.exitCode, timedOut: verify.timedOut, durationMs: verify.durationMs, outputTail: verify.output.slice(-1500) };
    if (verify.spawnError) { failureClass = "infra"; evidence.verify.spawnError = verify.spawnError; }
    else {
      verified = true;
      if (verify.timedOut) failureClass = "timeout";
      else if (verify.exitCode === 0 && changed.length > 0) { passed = true; failureClass = null; }
      else if (verify.exitCode === 0) failureClass = failureClass ?? "no_change";
      else failureClass = failureClass ?? "tests_failed";
      if (!passed && isQuotaRefusal(evidence.agentError ?? (outcome.status === "failed" ? evidence.agentMessage : undefined))) failureClass = "quota";
    }
  } catch (error) {
    failureClass = "infra";
    evidence.infraError = String(error?.message ?? error).slice(0, 500);
  } finally {
    await workspace?.cleanup();
  }
  const result = {
    taskId: task.id, target, passed, verified,
    toolCalls: outcome.toolCalls, toolErrors: outcome.toolErrors, repairs: outcome.repairs,
    latencyMs: Date.now() - started, ttftMs: outcome.ttftMs, tokens: outcome.tokens, costUsd: outcome.costUsd,
    failureClass: passed ? null : failureClass, evidence,
  };
  const resultProblems = validateResult(result);
  if (resultProblems.length > 0) throw new Error(`runner produced an invalid result: ${resultProblems.join(", ")}`);
  return result;
}

/** An agent that does nothing: the base must fail verification. */
export const noopAgent = async () => ({ status: "noop" });

/** An agent that applies the recorded solution: the fix must pass verification. */
export const goldAgent = (repoRoot) => async ({ root, task }) => {
  const { createWorkspaceView } = await import("./workspace.mjs");
  const view = createWorkspaceView(repoRoot, root);
  if (task.solution.paths) await view.applyPaths(task.solution.fromCommit, task.solution.paths);
  if (task.solution.files) await view.writeFiles(task.solution.files);
  return { status: "gold" };
};

/**
 * Proves a task is a real test: fails with no change (and the agent did
 * nothing), passes once the recorded solution is applied. No model involved.
 */
export async function validateFixture({ task, repoRoot }) {
  const problems = [];
  const base = await runTask({ task, target: "dry-run:noop", agent: noopAgent, repoRoot });
  if (base.passed) problems.push("verification passes without any change");
  else if (base.failureClass !== "tests_failed" && base.failureClass !== "no_change") problems.push(`baseline run did not reach verification (${base.failureClass}: ${base.evidence.infraError ?? ""})`);
  else if (base.failureClass === "no_change") problems.push("verification passes on the unmodified base (task is not a test)");
  const gold = await runTask({ task, target: "dry-run:gold", agent: goldAgent(repoRoot), repoRoot });
  if (!gold.passed) problems.push(`recorded solution does not pass verification (${gold.failureClass}): ${gold.evidence.verify?.outputTail?.slice(-300) ?? gold.evidence.infraError ?? ""}`);
  return { taskId: task.id, ok: problems.length === 0, problems, baseline: base, gold };
}
