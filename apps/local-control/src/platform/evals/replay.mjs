import { digest } from "../../../../../packages/atlas-contracts/src/index.mjs";

import { AuthorizedToolExecutor, PlatformTaskStore, PolicyEngine } from "../index.mjs";
import { AgentLoop, FINISH_TOOL, OrchestratorStore } from "../orchestrator/index.mjs";
import { compareManifests } from "./compare.mjs";
import { buildRunManifest, verifyManifest } from "./manifest.mjs";

/**
 * Replay: run a recorded mission again, through the real agent loop, executor,
 * policy engine, approval and budget code, in a disposable store, without
 * repeating a single side effect.
 *
 * The guarantee is structural. The replay environment is built from a manifest
 * and contains only:
 *
 *  - stub tools that answer with the recorded result of the matching step
 *    (same tool, same input) or refuse with REPLAY_UNRECORDED;
 *  - sandbox tools the caller names explicitly, which run against disposable
 *    fixtures (fixture re-execution). Whether a tool is safe to run is never
 *    taken from the manifest: a step having succeeded once proves nothing.
 *
 * No production tool, credential, connection or network handle is reachable
 * from here, so an email cannot be resent, a purchase repeated or a deploy
 * redone. The candidate that drives the loop is a model client: by default the
 * recording itself (pure replay, which checks that Atlas still behaves the way
 * it did), or any other client (a new model, prompt or router), which is how a
 * change is measured against what really happened.
 */
const RECORDED_ERROR = (step) => Object.assign(new Error(step.error?.message ?? "The recorded step failed."), { code: step.error?.code ?? "TOOL_ERROR", retryable: step.error?.retryable === true });

/** The recording as a model: the same proposals, with the same usage, in order. */
export function recordedModelClient(manifest) {
  let call = 0;
  return {
    async complete() {
      const index = call;
      call += 1;
      const usage = manifest.modelCalls[index];
      const step = manifest.steps[index];
      if (step) return { toolCalls: [{ name: step.tool, arguments: step.input }], ...(usage ? { usage } : {}) };
      if (manifest.outcome.completed) return { toolCalls: [{ name: FINISH_TOOL.name, arguments: { summary: "Replayed from a recorded mission." } }], ...(usage ? { usage } : {}) };
      return { content: "End of the recording." };
    },
  };
}

/** One verifier per success criterion: every recorded success must be reproduced. */
function replayVerifiers(manifest) {
  const expected = new Map();
  for (const step of manifest.steps) if (step.status === "succeeded") expected.set(step.tool, (expected.get(step.tool) ?? 0) + 1);
  return manifest.mission.successCriteria.map((criterion, index) => ({
    name: `replay_${index}`, criterion,
    check: ({ evidence }) => {
      const missing = [...expected].filter(([tool, count]) => evidence.filter((entry) => entry.tool === tool).length < count);
      if (missing.length > 0) return { ok: false, evidence: [], reason: `not reproduced: ${missing.map(([tool]) => tool).join(", ")}` };
      return { ok: true, evidence: [{ check: "recorded_steps_reproduced", steps: evidence.length }] };
    },
  }));
}

/**
 * @param {{
 *   manifest: object,
 *   policy?: PolicyEngine,
 *   modelClient?: { complete: Function },
 *   sandbox?: Record<string, (input: object) => Promise<{ output?: unknown, evidence?: object[] }>>,
 *   models?: string[],
 *   limits?: object,
 * }} options
 *   `policy` defaults to a document that grants nothing beyond the permissions
 *   the recording used; pass the live engine to ask "would today's policy
 *   still allow this?". `sandbox` is the only way anything executes.
 */
export async function replayManifest({ manifest, policy = null, modelClient = null, sandbox = {}, models = ["replay"], limits = {} }) {
  const verdict = verifyManifest(manifest);
  if (!verdict.ok) throw Object.assign(new Error(verdict.reason), { code: "INVALID_MANIFEST" });
  const tenantId = manifest.mission.tenantId;
  const store = new PlatformTaskStore(":memory:");
  const orch = new OrchestratorStore(":memory:");
  const served = [];
  const sandboxed = [];
  const unrecorded = [];
  try {
    const executor = new AuthorizedToolExecutor({ store, policy: policy ?? new PolicyEngine({ version: "replay.recorded-grants", rules: [] }) });
    const used = new Set();
    for (const tool of manifest.tools) {
      executor.register({
        name: tool.name, description: tool.description, risk: tool.risk, consequential: tool.consequential, inputSchema: tool.inputSchema,
        async execute(input) {
          if (sandbox[tool.name]) {
            sandboxed.push({ tool: tool.name, inputDigest: digest(input) });
            return sandbox[tool.name](input);
          }
          const key = digest(input);
          const step = manifest.steps.find((candidate) => !used.has(candidate.ordinal) && candidate.tool === tool.name && (candidate.inputDigest === key || candidate.redactedInputDigest === key));
          if (!step || (step.status !== "succeeded" && step.status !== "failed")) {
            unrecorded.push({ tool: tool.name, inputDigest: key });
            throw Object.assign(new Error(`No recorded result for this ${tool.name} call; replay does not execute tools.`), { code: "REPLAY_UNRECORDED", retryable: false });
          }
          used.add(step.ordinal);
          served.push({ tool: tool.name, ordinal: step.ordinal });
          if (step.status === "failed") throw RECORDED_ERROR(step);
          return { output: step.output, evidence: [{ kind: "replayed", recordedToolCallId: step.toolCallId }] };
        },
      });
    }

    const task = store.createTask({
      tenantId, userId: "replay", agentId: "replay", objective: manifest.mission.objective,
      successCriteria: manifest.mission.successCriteria.length ? manifest.mission.successCriteria : ["The recorded steps are reproduced."], budget: manifest.mission.budget,
    });
    store.transitionTask(tenantId, task.id, "authorized", { actor: "replay" });
    store.transitionTask(tenantId, task.id, "queued", { actor: "replay" });

    const loop = new AgentLoop({ store, executor, orchestratorStore: orch, modelClient: modelClient ?? recordedModelClient(manifest), limits: { maxSteps: manifest.steps.length + 6, ...limits }, owner: "replay" });
    const args = { tenantId, taskId: task.id, userId: "replay", grantedPermissions: manifest.grantedPermissions.patterns, verifiers: replayVerifiers(manifest), models };
    let result = await loop.run(args);
    // Approvals are resolved exactly as the recording shows them resolved, never invented.
    for (let round = 0; round <= manifest.steps.length && result.status === "waiting_for_approval"; round += 1) {
      let resolved = 0;
      for (const pending of store.listApprovals(tenantId, { taskId: task.id, status: "pending" })) {
        const recorded = manifest.steps.find((step) => step.tool === pending.tool && step.approval && step.approval.status !== "pending");
        if (!recorded) continue;
        store.resolveApproval(tenantId, pending.id, { decision: recorded.approval.status === "approved" ? "approved" : "rejected", resolvedBy: "replay:recorded-decision" });
        resolved += 1;
      }
      if (resolved === 0) break;
      result = await loop.run(args);
    }

    const replay = buildRunManifest({ store, tenantId, taskId: task.id, tools: executor.list(), runtime: { replayOf: manifest.manifestDigest } });
    return {
      replay, comparison: compareManifests(manifest, replay), loop: { status: result.status, errorClass: result.errorClass ?? null },
      safety: { externalExecutions: 0, served: served.length, sandboxExecutions: sandboxed.length, unrecorded },
    };
  } finally {
    store.close();
    orch.close();
  }
}
