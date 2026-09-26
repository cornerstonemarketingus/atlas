import { completeTurn, parseJsonReply, tokenUsage } from "./model.mjs";

export class PlanError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "PlanError";
    this.code = code;
  }
}

export const MAX_STEPS = 8;

/**
 * Validates a model-proposed plan against the real organization: every step
 * names an agent that exists and is live, dependencies point at earlier
 * steps (so no cycles are possible), and the plan is bounded.
 */
export function validatePlan(raw, roster) {
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.steps)) throw new PlanError("INVALID_PLAN", "The plan must have a list of steps.");
  if (!raw.steps.length) throw new PlanError("INVALID_PLAN", "The plan has no steps.");
  if (raw.steps.length > MAX_STEPS) throw new PlanError("PLAN_TOO_LARGE", `A plan may have at most ${MAX_STEPS} steps.`);
  const byName = new Map(roster.map((agent) => [agent.name.toLowerCase(), agent]));
  const seen = [];
  const steps = raw.steps.map((step, index) => {
    const id = `step-${index + 1}`;
    const title = typeof step?.title === "string" ? step.title.trim().slice(0, 200) : "";
    const instructions = typeof step?.instructions === "string" ? step.instructions.trim().slice(0, 2000) : "";
    const doneWhen = typeof step?.doneWhen === "string" ? step.doneWhen.trim().slice(0, 500) : "";
    if (!title || !instructions || !doneWhen) throw new PlanError("INVALID_STEP", `Step ${index + 1} needs a title, instructions and a doneWhen check.`);
    const agent = byName.get(String(step.agent ?? "").toLowerCase());
    if (!agent) throw new PlanError("UNKNOWN_AGENT", `Step ${index + 1} names '${String(step.agent ?? "").slice(0, 80)}', which is not an available agent.`);
    const dependsOn = Array.isArray(step.dependsOn) ? step.dependsOn.map((n) => Number(n)) : [];
    for (const n of dependsOn) {
      // Only earlier steps: a later or self reference would be a cycle.
      if (!Number.isInteger(n) || n < 1 || n > index) throw new PlanError("INVALID_DEPENDENCY", `Step ${index + 1} may only depend on earlier steps.`);
    }
    seen.push(id);
    return { id, title, instructions, doneWhen, agentId: agent.id, agentName: agent.name, dependencies: [...new Set(dependsOn)].map((n) => `step-${n}`) };
  });
  const successCriteria = Array.isArray(raw.successCriteria) ? raw.successCriteria.filter((c) => typeof c === "string" && c.trim()).map((c) => c.trim().slice(0, 500)).slice(0, 8) : [];
  return { summary: typeof raw.summary === "string" ? raw.summary.trim().slice(0, 1000) : "", successCriteria: successCriteria.length ? successCriteria : ["Every step is completed and verified."], steps };
}

/**
 * Asks the model for a plan over the agents that exist, then validates it.
 * One repair attempt: the validation error goes back to the model.
 */
export async function planMission({ client, model, goal, roster, signal }) {
  const agents = roster.map((a) => `- ${a.name} (${a.family}): can use ${a.tools.length ? a.tools.join(", ") : "no tools — reasoning and writing only"}`).join("\n");
  const messages = [
    { role: "system", content: "You are the planning lead of an AI organization. Break the goal into the smallest set of concrete steps, each assigned to exactly one listed agent whose tools fit the step. Respond with JSON only." },
    { role: "user", content: `Goal: ${goal}\n\nAvailable agents:\n${agents}\n\nReturn JSON: {"summary": "one sentence", "successCriteria": ["how we know the goal is met"], "steps": [{"title": "...", "agent": "exact agent name", "instructions": "what to do", "doneWhen": "a checkable condition", "dependsOn": [earlier step numbers]}]}. At most ${MAX_STEPS} steps. Do not invent agents or tools.` },
  ];
  const usage = { inputTokens: 0, outputTokens: 0 };
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const turn = await completeTurn(client, { model, messages, tools: [], maxOutputTokens: 1500, signal });
    const counted = tokenUsage(turn.usage, Math.ceil(JSON.stringify(messages).length / 4), Math.ceil(turn.text.length / 4));
    usage.inputTokens += counted.inputTokens;
    usage.outputTokens += counted.outputTokens;
    try {
      return { plan: validatePlan(parseJsonReply(turn.text), roster), usage };
    } catch (error) {
      lastError = error;
      messages.push({ role: "assistant", content: turn.text }, { role: "user", content: `That plan was rejected: ${error.message} Return corrected JSON only.` });
    }
  }
  throw lastError;
}
