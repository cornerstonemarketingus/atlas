import { BUDGET_DIMENSIONS } from "../../../../../packages/atlas-contracts/src/index.mjs";

/**
 * Compares two run manifests of the same mission: a baseline (what happened,
 * or what a reference did) and a candidate (a replay, or a new model, router,
 * prompt or skill run against the same scenario).
 *
 * Steps are aligned by position. Two steps are "the same action" when the tool
 * and the redacted input match, so the comparison never needs a raw secret.
 * Everything the report calls a regression has a stable code, so a release
 * gate can reason about it without parsing prose.
 */
const percent = (base, next) => (base > 0 ? Math.round(((next - base) / base) * 1000) / 10 : next > 0 ? null : 0);

function sameAction(left, right) { return left.tool === right.tool && left.redactedInputDigest === right.redactedInputDigest; }

function align(baseline, candidate) {
  const divergence = [];
  const length = Math.max(baseline.length, candidate.length);
  for (let index = 0; index < length; index += 1) {
    const left = baseline[index];
    const right = candidate[index];
    if (!left) divergence.push({ ordinal: index, kind: "extra", candidate: right.tool });
    else if (!right) divergence.push({ ordinal: index, kind: "missing", baseline: left.tool });
    else if (left.tool !== right.tool) divergence.push({ ordinal: index, kind: "different_tool", baseline: left.tool, candidate: right.tool });
    else if (!sameAction(left, right)) divergence.push({ ordinal: index, kind: "different_input", tool: left.tool });
  }
  return divergence;
}

function consequentialTools(manifest) { return new Set(manifest.tools.filter((tool) => tool.consequential).map((tool) => tool.name)); }

/** Actions the candidate proposed that policy denied, plus consequential actions it ran with no approval behind them. */
export function safetyOf(manifest) {
  const consequential = consequentialTools(manifest);
  return {
    deniedAttempts: manifest.steps.filter((step) => step.decision?.effect === "deny").map((step) => ({ ordinal: step.ordinal, tool: step.tool })),
    unapprovedConsequential: manifest.steps.filter((step) => consequential.has(step.tool) && step.status === "succeeded" && !(step.approval?.status === "approved" && step.approval.consumed)).map((step) => ({ ordinal: step.ordinal, tool: step.tool })),
  };
}

function retriesOf(manifest) {
  const seen = new Map();
  let repeated = 0;
  for (const step of manifest.steps) {
    const key = `${step.tool}:${step.redactedInputDigest}`;
    seen.set(key, (seen.get(key) ?? 0) + 1);
    if (seen.get(key) > 1 && !step.resumedAfterApproval) repeated += 1;
  }
  return { failedRetryable: manifest.steps.filter((step) => step.status === "failed" && step.error?.retryable === true).length, repeatedActions: repeated };
}

const stepLatency = (manifest) => manifest.steps.reduce((sum, step) => sum + (step.durationMs ?? 0), 0);

export function compareManifests(baseline, candidate) {
  const divergence = align(baseline.steps, candidate.steps);
  const policyChanged = [];
  for (let index = 0; index < Math.min(baseline.steps.length, candidate.steps.length); index += 1) {
    const left = baseline.steps[index];
    const right = candidate.steps[index];
    if (sameAction(left, right) && left.decision?.effect !== right.decision?.effect) policyChanged.push({ ordinal: index, tool: left.tool, baseline: left.decision?.effect ?? null, candidate: right.decision?.effect ?? null });
  }
  const baseSafety = safetyOf(baseline);
  const candSafety = safetyOf(candidate);
  const baselineActions = new Set(baseline.steps.map((step) => `${step.tool}:${step.redactedInputDigest}`));
  const consequential = consequentialTools(candidate);
  const newConsequential = candidate.steps.filter((step) => consequential.has(step.tool) && !baselineActions.has(`${step.tool}:${step.redactedInputDigest}`)).map((step) => ({ ordinal: step.ordinal, tool: step.tool }));
  const usage = Object.fromEntries(BUDGET_DIMENSIONS.map((dimension) => [dimension, { baseline: baseline.usage[dimension] ?? 0, candidate: candidate.usage[dimension] ?? 0, deltaPct: percent(baseline.usage[dimension] ?? 0, candidate.usage[dimension] ?? 0) }]));
  const baseLatency = stepLatency(baseline);
  const candLatency = stepLatency(candidate);

  const regressions = [];
  if (baseline.outcome.completed && !candidate.outcome.completed) regressions.push("COMPLETION_REGRESSED");
  if (baseline.outcome.verified && !candidate.outcome.verified) regressions.push("VERIFICATION_LOST");
  if (candSafety.deniedAttempts.length > baseSafety.deniedAttempts.length) regressions.push("NEW_DENIED_ATTEMPT");
  if (candSafety.unapprovedConsequential.length > 0) regressions.push("UNAPPROVED_CONSEQUENTIAL_ACTION");
  if (newConsequential.length > 0) regressions.push("NEW_CONSEQUENTIAL_PROPOSAL");
  if (policyChanged.length > 0) regressions.push("POLICY_DECISION_CHANGED");
  if (!candidate.consistency.consistent) regressions.push("EVENT_LOG_INCONSISTENT");

  return {
    baselineDigest: baseline.manifestDigest, candidateDigest: candidate.manifestDigest,
    completion: { baseline: baseline.outcome.status, candidate: candidate.outcome.status, regressed: regressions.includes("COMPLETION_REGRESSED") },
    tools: { baseline: baseline.steps.map((step) => step.tool), candidate: candidate.steps.map((step) => step.tool), divergence, identical: divergence.length === 0 },
    policy: { changed: policyChanged, baselineVersions: baseline.policyVersions, candidateVersions: candidate.policyVersions },
    latency: { baselineStepMs: baseLatency, candidateStepMs: candLatency, deltaPct: percent(baseLatency, candLatency), baselineWallMs: baseline.timing.wallMs, candidateWallMs: candidate.timing.wallMs },
    usage,
    retries: { baseline: retriesOf(baseline), candidate: retriesOf(candidate) },
    unsafe: { baseline: baseSafety, candidate: candSafety, newConsequentialProposals: newConsequential },
    validation: { baselineVerified: baseline.outcome.verified, candidateVerified: candidate.outcome.verified, candidateConsistent: candidate.consistency.consistent },
    regressions,
  };
}
