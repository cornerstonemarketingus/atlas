import { canonicalJson, digest } from "../../../../../packages/atlas-contracts/src/index.mjs";

/**
 * Multi-agent design debate (blueprint §13 E).
 *
 * N proposers each produce a design proposal. Proposals are then judged
 * against EXPLICIT criteria by executable checks — never by votes, opinions
 * or self-assessment embedded in a proposal:
 *
 *  - hard criteria: `check(proposal)` must return `{ pass: true }`; a check
 *    that throws or returns anything else counts as a failure;
 *  - soft criteria: `check(proposal)` returns `{ value: number }` (or
 *    `{ metrics: { [metric]: number } }`); values are min-max normalized
 *    across the proposals that passed every hard criterion, in the
 *    criterion's direction, and combined by weight.
 *
 * The winner passes all hard criteria and has the best weighted soft score.
 * If nobody passes, or the top two are within `tieEpsilon`, the debate
 * escalates instead of picking. Every proposal, evaluation and the decision
 * are recorded in a transcript whose entries carry provenance (who proposed,
 * which check produced a result, the proposal digest, timestamps), and the
 * transcript itself is digested so it can be referenced from an audit record.
 *
 * This module never calls a model. TODO(untrusted): a proposer that shows
 * other proposals (or fetched content) to a model must wrap them with
 * `wrapUntrusted` from src/agent/untrusted.mjs (not yet on this base).
 */

export class DebateError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "DebateError";
    this.code = code;
  }
}

/**
 * @param input.question what is being decided
 * @param input.proposers [{ id, agentId?, propose: async ({ question }) => proposal }]
 * @param input.criteria [{ id, kind: 'hard'|'soft', check: async (proposal, ctx) => result, weight?, direction?: 'maximize'|'minimize', metric? }]
 * @param input.clock () => Date
 * @param input.tieEpsilon soft-score margin under which the top two are treated as tied
 */
export async function runDesignDebate({ question, proposers, criteria, clock = () => new Date(), tieEpsilon = 1e-9 }) {
  if (typeof question !== "string" || !question) throw new DebateError("INVALID_ARGUMENT", "A question is required.");
  if (!Array.isArray(proposers) || proposers.length === 0) throw new DebateError("INVALID_ARGUMENT", "At least one proposer is required.");
  if (!Array.isArray(criteria) || criteria.length === 0) throw new DebateError("INVALID_ARGUMENT", "Explicit criteria are required.");
  const criterionIds = new Set();
  for (const c of criteria) {
    if (!c || typeof c.id !== "string" || !c.id) throw new DebateError("INVALID_CRITERION", "Every criterion needs an id.");
    if (criterionIds.has(c.id)) throw new DebateError("INVALID_CRITERION", `Criterion '${c.id}' is defined twice.`);
    criterionIds.add(c.id);
    if (!["hard", "soft"].includes(c.kind)) throw new DebateError("INVALID_CRITERION", `Criterion '${c.id}' must be 'hard' or 'soft'.`);
    if (typeof c.check !== "function") throw new DebateError("INVALID_CRITERION", `Criterion '${c.id}' needs an executable check.`);
    if (c.kind === "soft" && !(typeof (c.weight ?? 1) === "number" && (c.weight ?? 1) > 0)) throw new DebateError("INVALID_CRITERION", `Criterion '${c.id}' needs a positive weight.`);
    if (c.direction !== undefined && !["maximize", "minimize"].includes(c.direction)) throw new DebateError("INVALID_CRITERION", `Criterion '${c.id}' direction must be maximize or minimize.`);
  }

  const transcript = [];
  const log = (entry) => {
    transcript.push({ seq: transcript.length + 1, at: clock().toISOString(), ...entry });
  };
  log({ kind: "debate.opened", question, proposers: proposers.map((p) => p.id), criteria: criteria.map((c) => ({ id: c.id, kind: c.kind, weight: c.kind === "soft" ? c.weight ?? 1 : null, direction: c.direction ?? "maximize", description: c.description ?? null })) });

  // 1. Proposals.
  const proposals = [];
  for (const proposer of proposers) {
    if (!proposer || typeof proposer.id !== "string" || typeof proposer.propose !== "function") {
      throw new DebateError("INVALID_PROPOSER", "Every proposer needs an id and a propose function.");
    }
    try {
      const proposal = await proposer.propose({ question });
      if (proposal === undefined) throw new Error("proposer returned nothing");
      const proposalDigest = digest(proposal);
      proposals.push({ proposerId: proposer.id, agentId: proposer.agentId ?? null, proposal, proposalDigest });
      log({ kind: "proposal", proposerId: proposer.id, agentId: proposer.agentId ?? null, proposalDigest, proposal: jsonSafe(proposal) });
    } catch (error) {
      log({ kind: "proposal.failed", proposerId: proposer.id, agentId: proposer.agentId ?? null, error: String(error?.message ?? error) });
    }
  }

  // 2. Evaluation — every criterion on every proposal, by executable check.
  const evaluations = [];
  for (const entry of proposals) {
    const results = {};
    for (const criterion of criteria) {
      let result;
      try {
        const raw = await criterion.check(structuredClone(entry.proposal), { question, proposerId: entry.proposerId });
        result = criterion.kind === "hard" ? interpretHard(raw) : interpretSoft(raw, criterion);
      } catch (error) {
        result = criterion.kind === "hard"
          ? { pass: false, error: String(error?.message ?? error) }
          : { value: null, error: String(error?.message ?? error) };
      }
      results[criterion.id] = result;
      log({ kind: "evaluation", proposerId: entry.proposerId, proposalDigest: entry.proposalDigest, criterionId: criterion.id, criterionKind: criterion.kind, result: jsonSafe(result) });
    }
    const failedHard = criteria.filter((c) => c.kind === "hard" && results[c.id].pass !== true).map((c) => c.id);
    const missingSoft = criteria.filter((c) => c.kind === "soft" && typeof results[c.id].value !== "number").map((c) => c.id);
    evaluations.push({ ...entry, results, failedHard, missingSoft, passesHard: failedHard.length === 0 });
  }

  // 3. Soft scoring across hard-passing proposals.
  const passing = evaluations.filter((e) => e.passesHard);
  const soft = criteria.filter((c) => c.kind === "soft");
  const totalWeight = soft.reduce((sum, c) => sum + (c.weight ?? 1), 0);
  for (const e of evaluations) e.softScore = null;
  for (const e of passing) {
    let score = 0;
    for (const c of soft) {
      const values = passing.map((p) => p.results[c.id].value).filter((v) => typeof v === "number");
      const value = e.results[c.id].value;
      let normalized = 0; // an unmeasurable soft metric earns nothing
      if (typeof value === "number") {
        const min = Math.min(...values);
        const max = Math.max(...values);
        normalized = max === min ? 1 : (c.direction === "minimize" ? (max - value) / (max - min) : (value - min) / (max - min));
      }
      score += (c.weight ?? 1) * normalized;
    }
    e.softScore = totalWeight > 0 ? Math.round((score / totalWeight) * 1e6) / 1e6 : 0;
  }
  const ranked = [...passing].sort((a, b) => b.softScore - a.softScore || a.proposerId.localeCompare(b.proposerId));

  // 4. Decision.
  let decision;
  if (proposals.length === 0) {
    decision = { status: "escalated", reason: "no proposer produced a proposal", winner: null };
  } else if (ranked.length === 0) {
    decision = {
      status: "escalated", winner: null,
      reason: `no proposal passed every hard criterion (${evaluations.map((e) => `${e.proposerId}: failed ${e.failedHard.join(", ")}`).join("; ")})`,
    };
  } else if (ranked.length > 1 && Math.abs(ranked[0].softScore - ranked[1].softScore) <= tieEpsilon) {
    const tied = ranked.filter((e) => Math.abs(e.softScore - ranked[0].softScore) <= tieEpsilon).map((e) => e.proposerId);
    decision = { status: "escalated", winner: null, tied, reason: `tie on weighted soft score ${ranked[0].softScore} between ${tied.join(", ")}` };
  } else {
    const w = ranked[0];
    decision = {
      status: "decided",
      winner: { proposerId: w.proposerId, agentId: w.agentId, proposalDigest: w.proposalDigest, proposal: w.proposal, softScore: w.softScore },
      reason: `${w.proposerId} passed all ${criteria.filter((c) => c.kind === "hard").length} hard criteria with the best weighted soft score ${w.softScore}`
        + (ranked.length > 1 ? ` (next: ${ranked[1].proposerId} at ${ranked[1].softScore})` : ""),
    };
  }
  log({ kind: "decision", status: decision.status, winner: decision.winner?.proposerId ?? null, proposalDigest: decision.winner?.proposalDigest ?? null, reason: decision.reason, basis: "executable-criteria" });

  return {
    ...decision,
    scores: evaluations.map((e) => ({
      proposerId: e.proposerId, agentId: e.agentId, proposalDigest: e.proposalDigest, passesHard: e.passesHard,
      failedHard: e.failedHard, missingSoft: e.missingSoft, softScore: e.softScore, results: e.results,
    })),
    transcript,
    transcriptDigest: digest(transcript),
  };
}

function interpretHard(raw) {
  if (raw === true) return { pass: true };
  if (raw && typeof raw === "object") {
    return { pass: raw.pass === true, ...(raw.metrics && { metrics: raw.metrics }), ...(raw.detail !== undefined && { detail: String(raw.detail) }) };
  }
  return { pass: false, detail: "check did not return a pass/fail result" };
}

function interpretSoft(raw, criterion) {
  let value = null;
  if (typeof raw === "number") value = raw;
  else if (raw && typeof raw === "object") {
    if (typeof raw.value === "number") value = raw.value;
    else if (criterion.metric && typeof raw.metrics?.[criterion.metric] === "number") value = raw.metrics[criterion.metric];
  }
  if (value !== null && !Number.isFinite(value)) value = null;
  return { value, ...(raw && typeof raw === "object" && raw.metrics && { metrics: raw.metrics }), ...(raw?.detail !== undefined && { detail: String(raw.detail) }) };
}

function jsonSafe(value) {
  return JSON.parse(canonicalJson(value));
}
