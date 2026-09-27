import { TASK_TOOL, taskRequestsFromCalls } from "./atlas-knowledge.mjs";
import { instantToolDefinitions, isInstantTool, pendingLabel, runInstantTool } from "./instant-tools.mjs";
import { completionsUrl, replyText } from "./model-endpoint.mjs";
import { createDeltaParser } from "./stream.mjs";
import { eligibleTargets, ModelRecoveryState } from "./model-recovery.mjs";
export { retryAfterMs } from "./model-recovery.mjs";

/**
 * The agent loop behind one chat reply.
 *
 * Atlas may use instant tools (read a web page, search, read or search a
 * connected repository) for up to MAX_TOOL_STEPS rounds, seeing each result
 * before deciding what to do next, and then answers. Each tool call is
 * reported through `emit("tool", …)` while it runs, so the chat can show it as
 * a step. Long work the model asked for (start_atlas_task) starts once the
 * reply is written, through `startTasks`.
 */

/** Rounds of tool use before Atlas must answer. */
export const MAX_TOOL_STEPS = 6;
/** Instant tool calls honoured per round; extra calls in one round are answered as skipped. */
export const MAX_CALLS_PER_STEP = 4;
export const MAX_REPLY_TOKENS = 2048;
/** The longest wait honoured from a provider's retry-after before trying the fallback model instead. */
const MAX_RATE_LIMIT_WAIT_MS = 8_000;
const REQUEST_TIMEOUT_MS = 60_000;

function sendModel(endpoint, turns, { stream, tools, toolChoice = "auto", fetcher, maxTokens = MAX_REPLY_TOKENS, signal, timeoutMs = REQUEST_TIMEOUT_MS }) {
  const timeout = AbortSignal.timeout(Math.max(1, Math.min(REQUEST_TIMEOUT_MS, timeoutMs)));
  return fetcher(completionsUrl(endpoint.baseUrl), {
    method: "POST",
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    redirect: "error",
    headers: { "content-type": "application/json", ...(stream ? { accept: "text/event-stream" } : {}), ...(endpoint.apiKey ? { authorization: `Bearer ${endpoint.apiKey}` } : {}) },
    body: JSON.stringify({ model: endpoint.model, messages: turns, stream, temperature: 0.2, max_tokens: maxTokens, ...(tools ? { tools, tool_choice: toolChoice } : {}) }),
  });
}

/**
 * Retry short request limits once, then continue through the router's permitted
 * targets. No response content has been consumed here: switching cannot replay
 * tools or duplicate a partially streamed reply. Bound calls, wall time and waits.
 */
export async function callModel(endpoint, turns, options) {
  const state = endpoint.recoveryState ?? new ModelRecoveryState();
  const { targets, inputTokenEstimate } = eligibleTargets(endpoint, { ...options, turns });
  const deadline = state.now() + 90_000;
  let calls = 0;
  let waited = 0;
  let lastResponse;
  let lastError;
  const notify = (event) => { try { options.onRecovery?.(event); } catch { /* telemetry cannot interrupt work */ } };
  for (const target of targets) {
    options.signal?.throwIfAborted();
    if (!state.availability(target).available) continue;
    for (let retry = 0; retry < 2; retry += 1) {
      options.signal?.throwIfAborted();
      if (calls >= 16 || state.now() >= deadline) break;
      // Reserve the estimate synchronously before sending, including retries.
      // Parallel team calls share this turn's budget and cannot over-reserve it.
      if (target.estimatedCostMicroUsd > 0) {
        const budget = endpoint.recoveryBudget;
        if (!budget || target.estimatedCostMicroUsd > budget.maxCostMicroUsd - budget.spentMicroUsd) break;
        budget.spentMicroUsd += target.estimatedCostMicroUsd;
      }
      calls += 1;
      notify({ type: "model_attempt", targetId: target.id, provider: target.provider, model: target.model,
        estimatedCostMicroUsd: target.estimatedCostMicroUsd, turnId: options.turnId ?? null, attempt: calls });
      let response;
      try {
        response = await sendModel(target, turns, { ...options, timeoutMs: deadline - state.now() });
      } catch (error) {
        options.signal?.throwIfAborted();
        lastError = error;
        notify(state.record(target, null, new Headers(), { ...options, inputTokenEstimate, outputTokenEstimate: options.maxTokens ?? MAX_REPLY_TOKENS }));
        break;
      }
      if (response.ok) {
        if (lastResponse) await lastResponse.body?.cancel().catch(() => {});
        state.success(target); return response;
      }
      if (lastResponse) await lastResponse.body?.cancel().catch(() => {});
      lastResponse = response;
      // Existing no-tools compatibility retry remains in modelStep, after other
      // targets have had an opportunity to handle the full tool request.
      if (options.tools?.length && [400, 422].includes(response.status)) break;
      if (![429, 500, 502, 503, 504].includes(response.status)) return response;
      const event = state.record(target, response.status, response.headers, { ...options, inputTokenEstimate, outputTokenEstimate: options.maxTokens ?? MAX_REPLY_TOKENS });
      notify(event);
      const tokenOrDaily = ["tokens", "tpm", "tpd", "rpd", "input_tokens", "output_tokens"].includes(event.category);
      // Do not immediately resend an oversized context or spin on daily quota.
      // Provider-wide cooldowns also bypass sibling models in the outer loop.
      if (retry > 0 || response.status !== 429 || tokenOrDaily || event.waitMs > MAX_RATE_LIMIT_WAIT_MS - waited
        || state.now() + event.waitMs >= deadline) break;
      waited += event.waitMs;
      await response.body?.cancel().catch(() => {});
      lastResponse = undefined;
      await (options.sleep ?? sleep)(event.waitMs, options.signal);
      if (state.availability(target).until > event.limitedUntil) break;
    }
  }
  if (lastResponse) return lastResponse;
  if (lastError) throw lastError;
  return new Response(null, { status: targets.length && state.history().at(-1)?.httpStatus === 429 ? 429 : 503 });
}

/** Rate limits count every token resent each round, so results the model already used are cut to a digest. */
const COMPACT_TOOL_CHARS = 1_200;
export function compactOlderToolResults(turns, freshFrom) {
  for (let index = 0; index < freshFrom; index += 1) {
    const turn = turns[index];
    if (turn?.role !== "tool" || typeof turn.content !== "string" || turn.content.length <= COMPACT_TOOL_CHARS + 200) continue;
    const closes = turn.content.endsWith("</data>") ? "\n</data>" : "";
    turns[index] = { ...turn, content: `${turn.content.slice(0, COMPACT_TOOL_CHARS)}\n… (already read; shortened)${closes}` };
  }
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const finish = () => { signal?.removeEventListener("abort", abort); resolve(); };
    const timer = setTimeout(finish, ms);
    const abort = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); reject(signal.reason); };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

/**
 * One model call. Tools first; an endpoint that does not support tool
 * calling answers 400 or 422, and the call is retried without them rather
 * than failing. Streams thinking and words through `emit` as they arrive.
 */
async function modelStep({ endpoint, turns, tools, stream, emit, toolChoice, fetcher, maxTokens, sleep: pause, signal, turnId }) {
  const recovery = { signal, turnId, onRecovery: (event) => emit("model_recovery", event) };
  let response = await callModel(endpoint, turns, { stream, tools, toolChoice, fetcher, maxTokens, sleep: pause, ...recovery });
  let toolsDropped = false;
  if (tools && (response.status === 400 || response.status === 422)) {
    await response.body?.cancel().catch(() => {});
    response = await callModel(endpoint, turns, { stream, tools: null, fetcher, maxTokens, sleep: pause, ...recovery });
    toolsDropped = true;
  }
  if (!response.ok) return { ok: false, status: response.status };
  if (!stream || !response.body || !(response.headers.get("content-type") ?? "").includes("text/event-stream")) {
    // Not streaming, or a server that ignored stream:true: the whole reply at once.
    const payload = await response.json();
    const message = payload?.choices?.[0]?.message;
    const thought = message?.reasoning ?? message?.reasoning_content;
    if (typeof thought === "string" && thought) emit("thinking", { text: thought });
    const text = replyText(payload);
    if (text) emit("delta", { text });
    return { ok: true, text, calls: Array.isArray(message?.tool_calls) ? message.tool_calls : [], toolsDropped };
  }
  const parser = createDeltaParser();
  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  let text = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    const deltas = parser.push(decoder.decode(value, { stream: true }));
    // Thinking is streamed as its own event, before the words it led to; it is shown, never stored.
    const thought = parser.drainReasoning();
    if (thought) emit("thinking", { text: thought });
    for (const delta of deltas) {
      text += delta;
      emit("delta", { text: delta });
    }
  }
  return { ok: true, text, calls: parser.toolCalls, toolsDropped };
}

/**
 * @param {{
 *   endpoint: { baseUrl?: string, apiKey?: string | null, model?: string },
 *   turns: object[],
 *   toolContext: Parameters<typeof runInstantTool>[1] & { environment?: Record<string, string|undefined> },
 *   defaultRepository: string,
 *   userMessage: string,
 *   startTasks: (calls: ReturnType<typeof taskRequestsFromCalls>) => Promise<string[]>,
 *   stream: boolean,
 *   emit: (type: string, data: unknown) => void,
 *   fetcher?: typeof fetch,
 *   tools?: object[],
 *   handlers?: Record<string, ((call: object, helpers: { emit: (type: string, data: unknown) => void }) => Promise<{ ok: boolean, label: string, content: string, preview?: unknown }>) & { pending?: string }>,
 *   allowTasks?: boolean,
 *   maxRounds?: number,
 *   maxTokens?: number,
 *   agentId?: string,
 *   sleep?: (ms: number) => Promise<void>,
 *   signal?: AbortSignal,
 *   turnId?: string,
 * }} options
 * @returns {Promise<{ reply: string, steps: { label: string, ok: boolean }[] } | { error: string, status: number }>}
 */
export async function converse({ endpoint, turns, toolContext, defaultRepository = "", userMessage = "", startTasks = async () => [], stream, emit, fetcher = fetch, tools: toolOverride, handlers = {}, allowTasks = true, maxRounds = MAX_TOOL_STEPS, maxTokens = MAX_REPLY_TOKENS, agentId, sleep: pause, signal, turnId }) {
  endpoint = { ...endpoint, recoveryState: endpoint.recoveryState ?? new ModelRecoveryState() };
  // Child agents get their own, narrower tool list and no task starting; the lead gets everything.
  const tools = toolOverride ?? [...(allowTasks ? [TASK_TOOL] : []), ...instantToolDefinitions(toolContext?.environment ?? {})];
  const offered = new Set(tools.map((tool) => tool.function.name));
  const runnable = (name) => offered.has(name) && (isInstantTool(name) || name in handlers);
  const tag = agentId ? { agentId } : {};
  const working = [...turns];
  const taskCalls = [];
  const steps = [];
  let text = "";
  let toolsSupported = true;
  // Work already done is kept when a later round fails: what was found, plus why it stopped.
  const interrupted = (reason) => {
    const note = `${text.trim() ? "\n\n" : ""}_Stopped early: ${reason}_`;
    text += note;
    emit("delta", { text: note });
    return { reply: text.trim(), steps };
  };
  let freshFrom = working.length;
  for (let round = 0; round <= maxRounds; round += 1) {
    // Tool results the model has already read are shortened before the next round; the latest round's stay whole.
    compactOlderToolResults(working, freshFrom);
    freshFrom = working.length;
    let firstDelta = true;
    // Words from separate rounds read as separate paragraphs.
    const sink = (type, data) => {
      if (type === "delta") {
        if (firstDelta && text.trim()) { text += "\n\n"; emit("delta", { text: "\n\n" }); }
        firstDelta = false;
        text += data.text;
      }
      emit(type, data);
    };
    let result;
    try {
      // The last round keeps the tool definitions (earlier rounds' results refer to them) but must answer in words.
      result = await modelStep({ endpoint, turns: working, tools: toolsSupported && tools.length ? tools : null, stream, emit: sink, toolChoice: round < maxRounds ? "auto" : "none", fetcher, maxTokens, sleep: pause, signal, turnId });
    } catch (error) {
      const timedOut = error instanceof Error && error.name === "TimeoutError";
      const message = timedOut ? "The model endpoint did not answer in time." : "No model server answered. Check the endpoint in Connections.";
      if (round > 0) return interrupted(message);
      return { error: message, status: 504 };
    }
    // The status is the actionable part; the body can contain the prompt echoed back.
    if (!result.ok) {
      const message = result.status === 429
        ? "The permitted model targets are exhausted or cooling down after a rate limit (429). Your completed steps are preserved. Retry after the cooldown, or configure another permitted target in Connections."
        : `The model endpoint answered ${result.status}.`;
      if (round > 0) return interrupted(message);
      return { error: message, status: result.status === 429 ? 429 : 502 };
    }
    if (result.toolsDropped) toolsSupported = false;
    const calls = result.calls
      .filter((call) => typeof call?.function?.name === "string" && call.function.name)
      .map((call, index) => ({
        id: call.id || `call_${round}_${index}`,
        type: "function",
        function: { name: call.function.name, arguments: typeof call.function.arguments === "string" ? call.function.arguments : JSON.stringify(call.function.arguments ?? {}) },
      }));
    if (allowTasks) taskCalls.push(...calls.filter((call) => !runnable(call.function.name)));
    const instant = calls.filter((call) => runnable(call.function.name));
    if (instant.length === 0 || round === maxRounds) break;
    working.push({ role: "assistant", content: result.text || null, tool_calls: calls });
    let used = 0;
    for (const call of calls) {
      if (!runnable(call.function.name)) {
        working.push({ role: "tool", tool_call_id: call.id, content: allowTasks
          ? "Queued: this starts as soon as your reply is finished. Tell the person it is starting; do not claim a result."
          : `You cannot use '${call.function.name}'. Report what you found instead.` });
        continue;
      }
      if (used >= MAX_CALLS_PER_STEP) {
        working.push({ role: "tool", tool_call_id: call.id, content: `Skipped: at most ${MAX_CALLS_PER_STEP} lookups per round.` });
        continue;
      }
      used += 1;
      const handler = handlers[call.function.name];
      emit("tool", { id: call.id, label: handler ? handler.pending ?? `Running ${call.function.name.replaceAll("_", " ")}…` : pendingLabel(call), state: "running", ...tag });
      const outcome = handler ? await handler(call, { emit }) : await runInstantTool(call, toolContext);
      emit("tool", { id: call.id, label: outcome.label, state: outcome.ok ? "done" : "failed", ...tag, ...(outcome.preview ? { preview: outcome.preview } : {}) });
      steps.push({ label: outcome.label, ok: outcome.ok });
      working.push({ role: "tool", tool_call_id: call.id, content: outcome.content });
    }
  }
  if (!allowTasks) return { reply: text.trim(), steps };
  // Runs the model asked for start after its words, and each gets one line saying whether it started.
  const started = await startTasks(taskRequestsFromCalls(taskCalls.slice(0, 3), { defaultRepository, userMessage }));
  if (started.length) {
    const addition = `${text.trim() ? "\n\n" : ""}${started.join("\n\n")}`;
    text += addition;
    emit("delta", { text: addition });
  }
  return { reply: text.trim(), steps };
}
