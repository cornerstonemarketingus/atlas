import { customerEvent } from "./customer-events.mjs";

/**
 * Streaming for chat: parse an OpenAI-compatible server-sent-event stream
 * into text deltas, and encode Atlas's own events for the browser.
 *
 * Streaming is what makes the chat box feel alive — the first words appear
 * in about a second instead of after the whole reply is written.
 */

/**
 * Incremental parser for `data: {...}` lines. Feed it decoded text chunks in
 * any split; it returns the text deltas found so far and whether the server
 * signalled the end. Reasoning ("thinking") text is kept apart from the
 * answer: collected here and drained with `drainReasoning()`, so it can be
 * shown as thinking and never becomes part of the stored reply.
 */
export function createDeltaParser() {
  let buffer = "";
  let done = false;
  let finishReason = null;
  // Whether the server streamed any reasoning at all, and its token counts:
  // what tells an empty answer caused by a reasoning model running out of
  // room apart from any other empty answer. Neither carries content.
  let sawReasoning = false;
  let usage = null;
  // Tool calls arrive in pieces keyed by index: the name once, the JSON
  // arguments split across many chunks. They are assembled, never streamed.
  const calls = new Map();
  let reasoning = "";
  return {
    get done() { return done; },
    /** The finish_reason the server reported, if any ("stop", "length", "tool_calls"…). */
    get finishReason() { return finishReason; },
    get sawReasoning() { return sawReasoning; },
    /** Token counts from the stream's usage chunk (OpenAI `usage` or Groq `x_groq.usage`), if sent. */
    get usage() { return usage; },
    /** Parses whatever is left once the stream ends; a final event may lack its trailing newline. */
    finish(chunk = "") {
      return this.push(`${chunk}\n`);
    },
    /** Thinking text received since the last drain. */
    drainReasoning() {
      const text = reasoning;
      reasoning = "";
      return text;
    },
    /** Tool calls assembled so far, in the chat-completions message shape. */
    get toolCalls() {
      return [...calls.entries()].sort(([a], [b]) => a - b)
        .map(([, call]) => ({ id: call.id, type: "function", function: { name: call.name, arguments: call.arguments } }));
    },
    push(chunk) {
      buffer += chunk;
      const deltas = [];
      let newline;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline).replace(/\r$/u, "");
        buffer = buffer.slice(newline + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data) continue;
        if (data === "[DONE]") { done = true; continue; }
        let event;
        try { event = JSON.parse(data); } catch { continue; }
        const choice = Array.isArray(event?.choices) ? event.choices[0] : null;
        const pieces = choice?.delta?.tool_calls ?? choice?.message?.tool_calls;
        if (Array.isArray(pieces)) {
          for (const [position, piece] of pieces.entries()) {
            const index = Number.isInteger(piece?.index) ? piece.index : position;
            const call = calls.get(index) ?? { id: "", name: "", arguments: "" };
            if (typeof piece?.id === "string") call.id = piece.id;
            if (typeof piece?.function?.name === "string") call.name += piece.function.name;
            if (typeof piece?.function?.arguments === "string") call.arguments += piece.function.arguments;
            calls.set(index, call);
          }
        }
        const thought = choice?.delta?.reasoning ?? choice?.delta?.reasoning_content;
        if (typeof thought === "string" && thought) { reasoning += thought; sawReasoning = true; }
        const reported = event?.usage ?? event?.x_groq?.usage;
        if (reported && typeof reported === "object") usage = reported;
        const content = choice?.delta?.content ?? choice?.message?.content;
        if (typeof content === "string" && content) deltas.push(content);
        else if (Array.isArray(content)) {
          const text = content.map((part) => (typeof part === "string" ? part : part?.text ?? "")).join("");
          if (text) deltas.push(text);
        }
        if (choice?.finish_reason) { done = true; finishReason = choice.finish_reason; }
      }
      return deltas;
    },
  };
}

/**
 * How often a working turn proves it is alive. The browser gives up on a
 * stream that is silent for STREAM_IDLE_MS (app/chat/stream-idle.mjs), which
 * must stay well above this.
 */
export const KEEP_ALIVE_MS = 10_000;

const FAILED_TURN = "Atlas could not finish this request.";

/**
 * The body of a streaming chat turn. `run(emit)` does the turn's work and
 * emits its events. Whatever happens, the stream ends with a terminal event:
 * a turn that throws emits `error` and closes, instead of leaving the browser
 * with no terminal event. While the turn works, a comment line is sent every
 * `keepAliveMs` so a slow-but-alive turn is never mistaken for a dead one.
 * @param {(emit: (type: string, data: unknown) => void) => Promise<void>} run
 * @param {{ keepAliveMs?: number, onError?: (error: unknown) => void }} [options]
 * @returns {ReadableStream<Uint8Array>}
 */
export function chatEventStream(run, { keepAliveMs = KEEP_ALIVE_MS, onError = () => {} } = {}) {
  const encoder = new TextEncoder();
  let open = true;
  let timer;
  const stop = () => { open = false; clearInterval(timer); };
  return new ReadableStream({
    async start(controller) {
      const write = (text) => { if (open && text) { try { controller.enqueue(encoder.encode(text)); } catch { stop(); } } };
      const emit = (type, data) => write(encodeEvent(type, data));
      timer = setInterval(() => write(": keep-alive\n\n"), keepAliveMs);
      try {
        await run(emit);
      } catch (error) {
        try { onError(error); } catch { /* reporting never breaks the stream */ }
        emit("error", { message: FAILED_TURN });
      } finally {
        const wasOpen = open;
        stop();
        if (wasOpen) { try { controller.close(); } catch { /* already closed */ } }
      }
    },
    cancel() { stop(); },
  });
}

/** One server-sent event from Atlas to the browser. */
export function encodeEvent(type, data) {
  const visible = customerEvent(type, data);
  return visible === null ? "" : `event: ${type}\ndata: ${JSON.stringify(visible)}\n\n`;
}

/**
 * Parser for Atlas's own events on the browser side: yields { type, data }.
 */
export function createEventParser() {
  let buffer = "";
  return {
    push(chunk) {
      buffer += chunk;
      const events = [];
      let boundary;
      while ((boundary = buffer.indexOf("\n\n")) !== -1) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        let type = "message";
        let data = "";
        for (const line of block.split("\n")) {
          if (line.startsWith("event:")) type = line.slice(6).trim();
          else if (line.startsWith("data:")) data += line.slice(5).trim();
        }
        try { events.push({ type, data: data ? JSON.parse(data) : null }); } catch { /* ignore malformed */ }
      }
      return events;
    },
  };
}
