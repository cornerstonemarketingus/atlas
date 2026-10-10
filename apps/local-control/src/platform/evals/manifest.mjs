import { BUDGET_DIMENSIONS, digest } from "../../../../../packages/atlas-contracts/src/index.mjs";

import { redactSecrets } from "../memory/redaction.mjs";
import { redactValue, replayExecution } from "../orchestrator/replay.mjs";

/**
 * The run manifest: one mission, recorded from Atlas's own append-only event
 * log and tool-call tables, in a form a replay or an evaluation can use
 * without touching the world.
 *
 * Nothing here is collected by a second recorder. Steps come from the
 * `tool_calls` rows and the policy decisions and approvals beside them, the
 * usage from `budget.charged` events, the timing from event timestamps, and the
 * consistency verdict from `replayExecution` (which cross-checks all of them
 * against the log). Inputs, outputs and errors are redacted before they are
 * copied, and a manifest is refused if a secret-shaped string survives.
 *
 * What a manifest says about a tool (name, risk, `consequential`, schema) is a
 * description, never a licence: replay only runs a recorded step against a
 * stub, and only a fixture's own sandbox implementation may execute anything.
 */
export const MANIFEST_VERSION = "atlas.run-manifest/1";
export const RUNTIME_PROTOCOL = "atlas.platform/1";

const MAX_OUTPUT_CHARS = 8_000;
const PERMISSION_REASON = /permission '([^']+)' covers/u;

export class ManifestError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ManifestError";
    this.code = code;
  }
}

/** A recorded value, redacted and bounded; its digest is of the redacted form. */
function bounded(value) {
  const redacted = redactValue(value ?? null);
  const text = JSON.stringify(redacted);
  if (text !== undefined && text.length > MAX_OUTPUT_CHARS) return { truncated: true, preview: text.slice(0, MAX_OUTPUT_CHARS), digest: digest(redacted) };
  return redacted;
}

/** What a tool definition says about itself; the schema is data, not code. */
export function describeTool(tool) {
  const described = {
    name: tool.name, description: String(tool.description ?? "").slice(0, 500), risk: tool.risk ?? "moderate",
    consequential: tool.consequential === true,
    inputSchema: tool.inputSchema ?? { type: "object" }, timeoutMs: tool.timeoutMs ?? null,
  };
  return { ...described, fingerprint: digest({ name: described.name, risk: described.risk, consequential: described.consequential, inputSchema: described.inputSchema }) };
}

function timing(events) {
  const times = events.map((event) => Date.parse(event.createdAt)).filter(Number.isFinite);
  return times.length ? { startedAt: new Date(Math.min(...times)).toISOString(), endedAt: new Date(Math.max(...times)).toISOString(), wallMs: Math.max(...times) - Math.min(...times) } : { startedAt: null, endedAt: null, wallMs: 0 };
}

/**
 * @param {{ store: object, tenantId: string, taskId: string, tools?: object[], runtime?: object }} input
 *   `tools` are the executor's definitions (`executor.list()`); without them the
 *   manifest derives conservative ones from the calls it saw (every tool then
 *   counts as consequential).
 */
export function buildRunManifest({ store, tenantId, taskId, tools = null, runtime = {} }) {
  const task = store.getTask(tenantId, taskId);
  if (!task) throw new ManifestError("NOT_FOUND", "No such task in this tenant.");
  const report = replayExecution(store, tenantId, taskId);
  const events = [];
  for (let afterSeq = 0; ;) {
    const page = store.listEvents(tenantId, { taskId, afterSeq, limit: 1_000 });
    events.push(...page);
    if (page.length < 1_000) break;
    afterSeq = page.at(-1).seq;
  }
  const calls = store.getToolCalls(tenantId, taskId);
  const approvals = store.listApprovals(tenantId, { taskId });
  const resumed = new Set(events.filter((event) => event.type === "tool_call.requested" && event.payload?.resumed).map((event) => event.payload.toolCallId));
  const granted = new Set();

  // The tool-call row keeps only the latest policy decision; the log keeps all of them. The first is the
  // policy's answer to the proposal (an approved resumption is decided again as "allow").
  const decided = new Map();
  for (const event of events) {
    if (event.type !== "tool_call.decided" || !event.payload?.toolCallId) continue;
    const list = decided.get(event.payload.toolCallId) ?? [];
    list.push({ effect: event.payload.effect, reasons: (event.payload.reasons ?? []).map((reason) => redactSecrets(String(reason)).text), policyVersion: event.payload.policyVersion ?? null });
    decided.set(event.payload.toolCallId, list);
  }
  const steps = calls.map((call, index) => {
    const decisions = decided.get(call.id) ?? [];
    const decision = decisions[0] ?? null;
    const approval = approvals.find((candidate) => candidate.toolCallId === call.id) ?? null;
    for (const reason of decisions.flatMap((entry) => entry.reasons)) { const match = PERMISSION_REASON.exec(reason); if (match) granted.add(match[1]); }
    const input = redactValue(call.input ?? {});
    const output = call.output === null || call.output === undefined ? null : bounded(call.output);
    return {
      ordinal: index, toolCallId: call.id, tool: call.tool, status: call.status,
      input, inputDigest: digest(call.input ?? {}), redactedInputDigest: digest(input),
      decision, decisions,
      approval: approval ? { status: approval.status, resolvedBy: approval.resolvedBy ?? null, consumed: Boolean(approval.consumedBy) } : null,
      resumedAfterApproval: resumed.has(call.id),
      output, outputDigest: output === null ? null : digest(output),
      error: call.error ? bounded(call.error) : null, durationMs: call.durationMs ?? null,
    };
  });

  const modelCalls = events
    .filter((event) => event.type === "budget.charged" && event.payload?.phase === "charge" && (event.payload.amounts?.inputTokens !== undefined || event.payload.amounts?.outputTokens !== undefined))
    .map((event) => Object.fromEntries(BUDGET_DIMENSIONS.filter((dimension) => Number.isInteger(event.payload.amounts?.[dimension])).map((dimension) => [dimension, event.payload.amounts[dimension]])));
  const escalation = [...events].reverse().find((event) => event.type === "agent.message" && event.payload?.messageType === "ESCALATION")?.payload ?? null;
  const verified = store.listArtifacts(tenantId, { taskId }).some((artifact) => artifact.verification === "verified");
  const pending = approvals.filter((approval) => approval.status === "pending");

  const derived = tools === null;
  const toolDefinitions = (derived ? [...new Set(calls.map((call) => call.tool))].map((name) => ({ name, description: "Derived from a recorded call.", risk: "moderate", consequential: true, inputSchema: { type: "object" } })) : tools).map(describeTool);
  const policyVersions = [...new Set(steps.map((step) => step.decision?.policyVersion).filter(Boolean))];

  const body = {
    schema: MANIFEST_VERSION,
    runtime: { protocol: RUNTIME_PROTOCOL, ...runtime },
    mission: { taskId: task.id, tenantId, objective: redactSecrets(task.objective).text, successCriteria: task.successCriteria.map((criterion) => redactSecrets(criterion).text), budget: task.budget ?? {}, parentTaskId: task.parentTaskId ?? null },
    fingerprints: {
      tools: digest(toolDefinitions.map((tool) => tool.fingerprint).sort()),
      policy: digest(policyVersions.sort()),
      config: digest({ runtime, budget: task.budget ?? {} }),
    },
    policyVersions,
    grantedPermissions: { inferred: true, patterns: [...granted].sort() },
    tools: toolDefinitions, toolsDerived: derived,
    steps,
    modelCalls,
    approvals: approvals.map((approval) => ({ tool: approval.tool, status: approval.status, resolvedBy: approval.resolvedBy ?? null })),
    events: events.map((event) => ({ seq: event.seq, type: event.type, at: event.createdAt })),
    timing: timing(events),
    usage: Object.fromEntries(BUDGET_DIMENSIONS.map((dimension) => [dimension, task.usage?.[dimension] ?? 0])),
    outcome: {
      status: task.status, completed: task.status === "completed", verified,
      blocker: task.status === "completed" ? null : task.status === "waiting_for_approval" ? { kind: "approval", tools: pending.map((approval) => approval.tool) } : escalation ? { kind: "escalation", errorClass: escalation.errorClass ?? null } : task.error?.code ? { kind: "error", code: task.error.code } : null,
    },
    consistency: { consistent: report.consistent, issues: report.issues.map((entry) => ({ code: entry.code, severity: entry.severity ?? "error" })) },
  };
  const manifest = { ...body, manifestDigest: digest(body) };
  assertNoSecrets(manifest);
  return manifest;
}

/** A manifest is refused, not shipped, if a secret-shaped string survived redaction. */
export function assertNoSecrets(manifest) {
  const text = JSON.stringify(manifest);
  if (redactSecrets(text).text !== text) throw new ManifestError("SECRET_IN_MANIFEST", "A secret-shaped value survived redaction; the manifest was not produced.");
  return manifest;
}

/** Verifies a manifest has not been edited since it was built. */
export function verifyManifest(manifest) {
  if (manifest?.schema !== MANIFEST_VERSION) return { ok: false, reason: `Unsupported manifest version '${manifest?.schema}'.` };
  const { manifestDigest, ...body } = manifest;
  return digest(body) === manifestDigest ? { ok: true } : { ok: false, reason: "The manifest digest does not match its content." };
}
