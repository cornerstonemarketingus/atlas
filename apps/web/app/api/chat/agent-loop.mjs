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
const MAX_REPLY_TOKENS = 4096;
const REQUEST_TIMEOUT_MS = 60_000;

function callModel(endpoint, turns, { stream, tools, toolChoice = "auto", fetcher }) {
  return fetcher(completionsUrl(endpoint.baseUrl), {
    method: "POST",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: { "content-type": "application/json", ...(stream ? { accept: "text/event-stream" } : {}), ...(endpoint.apiKey ? { authorization: `Bearer ${endpoint.apiKey}` } : {}) },
    body: JSON.stringify({ model: endpoint.model, messages: turns, stream, temperature: 0.2, max_tokens: MAX_REPLY_TOKENS, ...(tools ? { tools, tool_choice: toolChoice } : {}) }),
  });
}

/**
 * One model call. Tools first; an endpoint that does not support tool
 * calling answers 400 or 422, and the call is retried without them rather
 * than failing. Streams thinking and words through `emit` as they arrive.
 */
async function modelStep({ endpoint, turns, tools, stream, emit, toolChoice, fetcher }) {
  let response = await callModel(endpoint, turns, { stream, tools, toolChoice, fetcher });
  let toolsDropped = false;
  if (tools && (response.status === 400 || response.status === 422)) {
    response = await callModel(endpoint, turns, { stream, tools: null, fetcher });
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
 * }} options
 * @returns {Promise<{ reply: string, steps: { label: string, ok: boolean }[] } | { error: string, status: number }>}
 */
export async function converse({ endpoint, turns, toolContext, defaultRepository, userMessage, startTasks, stream, emit, fetcher = fetch }) {
  const tools = [TASK_TOOL, ...instantToolDefinitions(toolContext?.environment ?? {})];
  const working = [...turns];
  const taskCalls = [];
  const steps = [];
  let text = "";
  let toolsSupported = true;
  for (let round = 0; round <= MAX_TOOL_STEPS; round += 1) {
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
      result = await modelStep({ endpoint, turns: working, tools: toolsSupported ? tools : null, stream, emit: sink, toolChoice: round < MAX_TOOL_STEPS ? "auto" : "none", fetcher });
    } catch (error) {
      const timedOut = error instanceof Error && error.name === "TimeoutError";
      return { error: timedOut ? "The model endpoint did not answer in time." : "No model server answered. Check the endpoint in Connections.", status: 504 };
    }
    // The status is the actionable part; the body can contain the prompt echoed back.
    if (!result.ok) return { error: `The model endpoint answered ${result.status}.`, status: 502 };
    if (result.toolsDropped) toolsSupported = false;
    const calls = result.calls
      .filter((call) => typeof call?.function?.name === "string" && call.function.name)
      .map((call, index) => ({
        id: call.id || `call_${round}_${index}`,
        type: "function",
        function: { name: call.function.name, arguments: typeof call.function.arguments === "string" ? call.function.arguments : JSON.stringify(call.function.arguments ?? {}) },
      }));
    taskCalls.push(...calls.filter((call) => !isInstantTool(call.function.name)));
    const instant = calls.filter((call) => isInstantTool(call.function.name));
    if (instant.length === 0 || round === MAX_TOOL_STEPS) break;
    working.push({ role: "assistant", content: result.text || null, tool_calls: calls });
    let used = 0;
    for (const call of calls) {
      if (!isInstantTool(call.function.name)) {
        working.push({ role: "tool", tool_call_id: call.id, content: "Queued: this starts as soon as your reply is finished. Tell the person it is starting; do not claim a result." });
        continue;
      }
      if (used >= MAX_CALLS_PER_STEP) {
        working.push({ role: "tool", tool_call_id: call.id, content: `Skipped: at most ${MAX_CALLS_PER_STEP} lookups per round.` });
        continue;
      }
      used += 1;
      emit("tool", { id: call.id, label: pendingLabel(call), state: "running" });
      const outcome = await runInstantTool(call, toolContext);
      emit("tool", { id: call.id, label: outcome.label, state: outcome.ok ? "done" : "failed" });
      steps.push({ label: outcome.label, ok: outcome.ok });
      working.push({ role: "tool", tool_call_id: call.id, content: outcome.content });
    }
  }
  // Runs the model asked for start after its words, and each gets one line saying whether it started.
  const started = await startTasks(taskRequestsFromCalls(taskCalls.slice(0, 3), { defaultRepository, userMessage }));
  if (started.length) {
    const addition = `${text.trim() ? "\n\n" : ""}${started.join("\n\n")}`;
    text += addition;
    emit("delta", { text: addition });
  }
  return { reply: text.trim(), steps };
}
