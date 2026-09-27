import { TASK_TOOL, taskRequestsFromCalls } from "./atlas-knowledge.mjs";
import { instantToolDefinitions, isInstantTool, pendingLabel, runInstantTool } from "./instant-tools.mjs";
import { completionsUrl, replyText } from "./model-endpoint.mjs";
import { createDeltaParser } from "./stream.mjs";

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

function sendModel(endpoint, turns, { stream, tools, toolChoice = "auto", fetcher, maxTokens = MAX_REPLY_TOKENS }) {
  return fetcher(completionsUrl(endpoint.baseUrl), {
    method: "POST",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: { "content-type": "application/json", ...(stream ? { accept: "text/event-stream" } : {}), ...(endpoint.apiKey ? { authorization: `Bearer ${endpoint.apiKey}` } : {}) },
    body: JSON.stringify({ model: endpoint.model, messages: turns, stream, temperature: 0.2, max_tokens: maxTokens, ...(tools ? { tools, tool_choice: toolChoice } : {}) }),
  });
}

const DURATION_UNIT_MS = { h: 3_600_000, m: 60_000, s: 1_000, ms: 1, us: 0.001, "µs": 0.001, ns: 0.000_001 };
const DURATION = /^(?:\d+(?:\.\d+)?(?:ms|us|µs|ns|h|m|s))+$/u;

/** A Go-style duration as Groq reports it ("7.66s", "340ms", "2m59.56s") in milliseconds, or null. */
export function durationMs(text) {
  const trimmed = String(text ?? "").trim();
  if (!DURATION.test(trimmed)) return null;
  let total = 0;
  for (const [, amount, unit] of trimmed.matchAll(/(\d+(?:\.\d+)?)(ms|us|µs|ns|h|m|s)/gu)) total += Number(amount) * DURATION_UNIT_MS[unit];
  return Math.ceil(total);
}

/**
 * Milliseconds a 429 asks us to wait: retry-after in seconds, then the wait
 * the body names ("Please try again in 2m59.56s."), then Groq's reset header.
 * A wait over a minute (a daily quota) must be read as such, or the chat
 * retries into a limit that is certain to refuse it again.
 */
export function retryAfterMs(headers, body = "") {
  const after = headers.get("retry-after")?.trim() ?? "";
  if (/^\d+(?:\.\d+)?$/u.test(after)) return Math.ceil(Number(after) * 1000);
  const suggested = /try again in ((?:\d+(?:\.\d+)?(?:ms|us|µs|ns|h|m|s))+)/iu.exec(body);
  const fromBody = suggested ? durationMs(suggested[1]) : null;
  if (fromBody !== null) return fromBody;
  const reset = durationMs(headers.get("x-ratelimit-reset-tokens") ?? headers.get("x-ratelimit-reset-requests") ?? "");
  return reset ?? 2_000;
}

/**
 * Sends a model request, riding out rate limits: on 429, wait what the
 * provider asks (when that is short) and retry once, then try the fallback
 * model on the same endpoint. Other statuses are returned as they are.
 */
export async function callModel(endpoint, turns, options) {
  let response = await sendModel(endpoint, turns, options);
  if (response.status !== 429) return response;
  const wait = retryAfterMs(response.headers, await response.clone().text().catch(() => ""));
  if (wait <= MAX_RATE_LIMIT_WAIT_MS) {
    await (options.sleep ?? sleep)(wait);
    response = await sendModel(endpoint, turns, options);
    if (response.status !== 429) return response;
  }
  if (endpoint.fallbackModel) return sendModel({ ...endpoint, model: endpoint.fallbackModel }, turns, options);
  return response;
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * One model call. Tools first; an endpoint that does not support tool
 * calling answers 400 or 422, and the call is retried without them rather
 * than failing. Streams thinking and words through `emit` as they arrive.
 */
async function modelStep({ endpoint, turns, tools, stream, emit, toolChoice, fetcher, maxTokens, sleep: pause }) {
  let response = await callModel(endpoint, turns, { stream, tools, toolChoice, fetcher, maxTokens, sleep: pause });
  let toolsDropped = false;
  if (tools && (response.status === 400 || response.status === 422)) {
    response = await callModel(endpoint, turns, { stream, tools: null, fetcher, maxTokens, sleep: pause });
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
 * }} options
 * @returns {Promise<{ reply: string, steps: { label: string, ok: boolean }[] } | { error: string, status: number }>}
 */
export async function converse({ endpoint, turns, toolContext, defaultRepository = "", userMessage = "", startTasks = async () => [], stream, emit, fetcher = fetch, tools: toolOverride, handlers = {}, allowTasks = true, maxRounds = MAX_TOOL_STEPS, maxTokens = MAX_REPLY_TOKENS, agentId, sleep: pause }) {
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
      result = await modelStep({ endpoint, turns: working, tools: toolsSupported && tools.length ? tools : null, stream, emit: sink, toolChoice: round < maxRounds ? "auto" : "none", fetcher, maxTokens, sleep: pause });
    } catch (error) {
      const timedOut = error instanceof Error && error.name === "TimeoutError";
      const message = timedOut ? "The model endpoint did not answer in time." : "No model server answered. Check the endpoint in Connections.";
      if (round > 0) return interrupted(message);
      return { error: message, status: 504 };
    }
    // The status is the actionable part; the body can contain the prompt echoed back.
    if (!result.ok) {
      const message = result.status === 429
        ? "The model provider's rate limit was reached (429). Wait a minute and ask again, or set a higher-limit model or ATLAS_CHAT_FALLBACK_MODEL."
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
