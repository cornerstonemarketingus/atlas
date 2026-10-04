import { randomUUID } from "node:crypto";

import { completeTurn, tokenUsage } from "../team/model.mjs";
import { wrapUntrusted } from "../untrusted.mjs";
import { mountCapabilities } from "./capabilities.mjs";
import { observationFor } from "./observations.mjs";

/**
 * The Atlas agent kernel: one execution loop every agent runs through.
 *
 *   goal → perceive → retrieve context → plan/choose capability → act →
 *   observe → update world state → verify → continue / escalate → finish
 *
 * An agent run is a composition, not a kind:
 *
 *   { goal, intelligence, identity, capabilities, environment, budget, policy, memory, context }
 *
 * - goal         { title, instructions, doneWhen }
 * - intelligence { client, model, maxOutputTokens }
 * - identity     { agentId, name, systemPrompt }
 * - capabilities names from CAPABILITIES (code, browser, computer, …), mounted
 *                for this run and narrowed by policy.allowedToolCapabilities
 * - environment  where it runs ({ kind: "local", repository? })
 * - budget       the mission budget (record()); spending stops the run there
 * - policy       { allowedToolCapabilities, maxToolTurns, attempts }
 * - memory       recall() → { ids, text } of what this agent may remember
 *
 * The caller supplies how a tool call is executed (policy, approvals and
 * audit stay where they are) and how a result is verified. The kernel owns
 * the loop, the trace and the world state: every phase is traced on the run,
 * every tool call becomes an observation, and the agent perceives the world
 * state (its task, what earlier runs touched) as data before it acts.
 */
export const DEFAULT_MAX_TOOL_TURNS = 8;
export const DEFAULT_ATTEMPTS = 2;

export function createKernel({ toolRegistry, world = null }) {
  const trace = (runId, phase, data) => { try { world?.trace(runId, phase, data); } catch { /* the trace never stops a run */ } };
  const observe = (observation) => { try { world?.apply(observation); } catch { /* an unrecordable observation never stops a run */ } };

  async function run(spec, { signal = null, budget = { record() {} }, checkpoint = async () => {}, executeTool, verify }) {
    const runId = spec.runId ?? `run-${randomUUID()}`;
    const { goal, intelligence, identity, environment = { kind: "local" }, policy = {}, memory = null, context = {} } = spec;
    const maxToolTurns = policy.maxToolTurns ?? DEFAULT_MAX_TOOL_TURNS;
    const attempts = policy.attempts ?? DEFAULT_ATTEMPTS;

    // Goal: the run, its task and its agent become part of the world.
    const taskRef = spec.task ?? { type: "task", key: runId };
    observe({
      source: `run:${runId}`,
      entities: [
        { type: "run", key: runId, attrs: { goal: goal.title, status: "running", capabilities: spec.capabilities, environment: environment.kind } },
        { type: "task", key: taskRef.key, attrs: { title: goal.title, doneWhen: goal.doneWhen } },
        ...(identity?.agentId ? [{ type: "agent", key: identity.agentId, attrs: { name: identity.name } }] : []),
      ],
      relations: [
        { from: { type: "run", key: runId }, relation: "part_of", to: { type: "task", key: taskRef.key } },
        ...(identity?.agentId ? [{ from: { type: "run", key: runId }, relation: "created_by", to: { type: "agent", key: identity.agentId } }] : []),
      ],
    });
    trace(runId, "goal", { title: goal.title, doneWhen: goal.doneWhen, agent: identity?.name ?? null });

    // Capabilities: mounted for this run, narrowed by the agent's permissions.
    const mount = mountCapabilities(toolRegistry, { capabilities: spec.capabilities, allowedToolCapabilities: policy.allowedToolCapabilities ?? null });
    trace(runId, "mount", { capabilities: mount.mounted.map((m) => ({ name: m.name, tools: m.tools.length })), gaps: mount.gaps });
    if (mount.gaps.length) {
      observe({ source: `run:${runId}`, entities: [{ type: "event", key: `${runId}:gaps`, attrs: { kind: "capability_gap", capabilities: mount.gaps } }], relations: [{ from: { type: "event", key: `${runId}:gaps` }, relation: "part_of", to: { type: "run", key: runId } }] });
    }

    // Perceive: the world as it stands around this task, as data.
    const perceived = world ? world.snapshot({ focus: [`task:${taskRef.key}`, ...(context.focus ?? [])], limit: 20, depth: 2 }) : { text: "", entities: [] };
    trace(runId, "perceive", { entities: perceived.entities.length });

    // Retrieve context: memory the agent may read, and upstream results.
    const recalled = memory?.recall ? await memory.recall() : { ids: [], text: "" };
    trace(runId, "retrieve", { memories: recalled.ids.length, upstream: Boolean(context.upstream) });

    const messages = [
      { role: "system", content: identity.systemPrompt },
      { role: "user", content: [
        `Step: ${goal.title}\nInstructions: ${goal.instructions}\nDone when: ${goal.doneWhen}`,
        context.upstream ? wrapUntrusted("earlier steps", context.upstream).text : "",
        recalled.text ? wrapUntrusted("family memory", recalled.text).text : "",
        perceived.text ? wrapUntrusted("world state", perceived.text).text : "",
      ].filter(Boolean).join("\n\n") },
    ];
    const usage = { inputTokens: 0, outputTokens: 0, toolCalls: 0 };
    const toolLog = [];
    const toolOutcomes = [];
    let report = "";
    let verdict = null;
    let feedback = null;
    let seq = 0;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      if (feedback) messages.push({ role: "user", content: `A reviewer checked your report and it does not yet satisfy "${goal.doneWhen}": ${feedback} Continue the step and report again.` });
      trace(runId, "plan", { attempt });
      report = await act();
      await checkpoint();
      verdict = await verify({ report, toolLog, toolOutcomes, usage, signal });
      trace(runId, "verify", { attempt, passed: verdict.passed, reason: verdict.reason, checker: verdict.checker ?? null });
      if (verdict.passed) break;
      feedback = verdict.reason;
      const waiting = toolOutcomes.some((outcome) => outcome.status === "awaiting_approval");
      trace(runId, "decide", { next: attempt < attempts ? "continue" : waiting ? "escalate" : "finish", reason: verdict.reason });
    }

    const passed = Boolean(verdict?.passed);
    observe({ source: `run:${runId}`, entities: [{ type: "run", key: runId, attrs: { status: passed ? "verified" : "unverified", reason: passed ? null : verdict?.reason ?? null } }] });
    trace(runId, "finish", { passed, toolCalls: usage.toolCalls, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens });
    return { runId, report, verdict: verdict ?? { passed: false, reason: "No attempt ran." }, usage, toolLog, toolOutcomes, recalled, mount };

    async function act() {
      for (let turn = 0; turn < maxToolTurns; turn += 1) {
        await checkpoint();
        const reply = await completeTurn(intelligence.client, { model: intelligence.model, messages, tools: mount.tools, maxOutputTokens: intelligence.maxOutputTokens ?? 1500, signal });
        const counted = tokenUsage(reply.usage, Math.ceil(JSON.stringify(messages).length / 4), Math.ceil(reply.text.length / 4));
        usage.inputTokens += counted.inputTokens;
        usage.outputTokens += counted.outputTokens;
        budget.record(counted);
        if (!reply.toolCalls.length) return reply.text || "(no report)";
        messages.push({ role: "assistant", content: reply.text, tool_calls: reply.toolCalls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.arguments } })) });
        for (const call of reply.toolCalls) {
          budget.record({ toolCalls: 1 });
          usage.toolCalls += 1;
          const before = toolLog.length;
          const content = await executeTool(call, { allowedTools: mount.names, toolLog, toolOutcomes, checkpoint, signal });
          const logged = toolLog[before] ?? { tool: call.name, status: "failed", code: null };
          let input = {};
          try { input = JSON.parse(call.arguments || "{}"); } catch { /* observed without inputs */ }
          seq += 1;
          trace(runId, "act", { tool: call.name, status: logged.status, code: logged.code ?? null });
          observe(observationFor({ runId, seq, call, input: input && typeof input === "object" ? input : {}, status: logged.status, code: logged.code ?? null, environment }));
          messages.push({ role: "tool", tool_call_id: call.id, content: wrapUntrusted(call.name, content).text });
        }
      }
      return "The step used all of its tool turns without finishing.";
    }
  }

  /**
   * A run whose act phase is an external harness (the atlas-cli coder today;
   * a Claude/Codex/browser harness tomorrow) with its own inner loop. The
   * kernel still owns the goal, the trace, the world state and the verdict:
   * the harness is one capability, not a separate kind of agent.
   *
   * `harness()` returns { ok, cancelled?, summary, artifacts?: [{ kind, key, attrs }] }.
   * The run is verified only when the harness reports success AND `verify`
   * (default: at least one artifact) agrees.
   */
  async function runHarness(spec, harness, { verify = (result) => ({ passed: Boolean(result.artifacts?.length), reason: result.artifacts?.length ? "The harness produced its artifact." : "The harness produced nothing to review." }) } = {}) {
    const runId = spec.runId ?? `run-${randomUUID()}`;
    const { goal, identity = null, environment = { kind: "local" } } = spec;
    const taskRef = spec.task ?? { type: "task", key: runId };
    const repository = environment.repository ? { type: "repository", key: environment.repository, attrs: { name: environment.repository } } : null;
    observe({
      source: `run:${runId}`,
      entities: [
        { type: "run", key: runId, attrs: { goal: goal.title, status: "running", capabilities: spec.capabilities, harness: spec.harness, model: spec.model ?? null, environment: environment.kind } },
        { type: "task", key: taskRef.key, attrs: { title: goal.title, doneWhen: goal.doneWhen ?? null } },
        ...(repository ? [repository] : []),
      ],
      relations: [
        { from: { type: "run", key: runId }, relation: "part_of", to: { type: "task", key: taskRef.key } },
        ...(repository ? [{ from: { type: "run", key: runId }, relation: "uses", to: repository }] : []),
      ],
    });
    trace(runId, "goal", { title: goal.title, doneWhen: goal.doneWhen ?? null, agent: identity?.name ?? null });
    trace(runId, "mount", { capabilities: (spec.capabilities ?? []).map((name) => ({ name, harness: spec.harness })), gaps: [] });
    trace(runId, "act", { harness: spec.harness });
    let result;
    try {
      result = await harness();
    } catch (error) {
      result = { ok: false, summary: error instanceof Error ? error.message : String(error) };
    }
    const artifacts = result.artifacts ?? [];
    observe({
      source: `run:${runId}`,
      entities: artifacts.map((artifact) => ({ type: "artifact", key: artifact.key, attrs: { kind: artifact.kind, ...artifact.attrs } })),
      relations: [
        ...artifacts.map((artifact) => ({ from: { type: "run", key: runId }, relation: "produced", to: { type: "artifact", key: artifact.key } })),
        ...(repository ? artifacts.map((artifact) => ({ from: { type: "artifact", key: artifact.key }, relation: "part_of", to: repository })) : []),
      ],
    });
    trace(runId, "observe", { ok: Boolean(result.ok), cancelled: Boolean(result.cancelled), artifacts: artifacts.map((a) => a.kind) });
    const verdict = result.ok ? verify(result) : { passed: false, reason: result.cancelled ? "Cancelled." : String(result.summary ?? "The harness failed.").slice(0, 500) };
    trace(runId, "verify", { passed: verdict.passed, reason: verdict.reason, checker: "harness" });
    const status = verdict.passed ? "verified" : result.cancelled ? "cancelled" : "unverified";
    observe({ source: `run:${runId}`, entities: [{ type: "run", key: runId, attrs: { status, reason: verdict.passed ? null : verdict.reason } }] });
    trace(runId, "finish", { passed: verdict.passed });
    return { runId, result, verdict };
  }

  /**
   * A run whose act loop belongs to the caller (the streaming chat loop):
   * the kernel records the goal, capabilities, perception, every action and
   * the outcome, exactly as for `run`, while the caller keeps its own model
   * loop. Returns a handle; `finish` is idempotent.
   */
  function begin(spec) {
    const runId = spec.runId ?? `run-${randomUUID()}`;
    const { goal, identity = null, environment = { kind: "local" } } = spec;
    const taskRef = spec.task ?? { type: "task", key: runId };
    observe({
      source: `run:${runId}`,
      entities: [
        { type: "run", key: runId, attrs: { goal: goal.title, status: "running", capabilities: spec.capabilities, harness: spec.harness ?? null, environment: environment.kind } },
        { type: "task", key: taskRef.key, attrs: { title: spec.taskTitle ?? goal.title } },
        ...(identity?.agentId ? [{ type: "agent", key: identity.agentId, attrs: { name: identity.name } }] : []),
      ],
      relations: [
        { from: { type: "run", key: runId }, relation: "part_of", to: { type: "task", key: taskRef.key } },
        ...(identity?.agentId ? [{ from: { type: "run", key: runId }, relation: "created_by", to: { type: "agent", key: identity.agentId } }] : []),
      ],
    });
    trace(runId, "goal", { title: goal.title, doneWhen: goal.doneWhen ?? null, agent: identity?.name ?? null });
    trace(runId, "mount", { capabilities: (spec.capabilities ?? []).map((name) => ({ name })), gaps: [] });
    let seq = 0;
    let finished = false;
    return {
      runId,
      /** What Atlas already knows around this task (earlier turns, what they touched), as text; "" when nothing. */
      perceive({ focus = [], limit = 15 } = {}) {
        const perceived = world ? world.snapshot({ focus: [`task:${taskRef.key}`, ...focus], limit, depth: 2 }) : { text: "", entities: [] };
        // The run itself is always there; perceiving only it is perceiving nothing.
        const others = perceived.entities.filter((entity) => entity.id !== `run:${runId}` && entity.id !== `task:${taskRef.key}`);
        trace(runId, "perceive", { entities: others.length });
        return others.length ? perceived.text : "";
      },
      act({ call, input = {}, status, code = null }) {
        seq += 1;
        trace(runId, "act", { tool: call.name, status, code });
        observe(observationFor({ runId, seq, call, input: input && typeof input === "object" ? input : {}, status, code, environment }));
      },
      finish({ passed, reason = null, status = null }) {
        if (finished) return;
        finished = true;
        trace(runId, "verify", { passed: Boolean(passed), reason, checker: spec.checker ?? "caller" });
        observe({ source: `run:${runId}`, entities: [{ type: "run", key: runId, attrs: { status: status ?? (passed ? "verified" : "unverified"), reason: passed ? null : reason } }] });
        trace(runId, "finish", { passed: Boolean(passed), toolCalls: seq });
      },
    };
  }

  return { run, runHarness, begin };
}
