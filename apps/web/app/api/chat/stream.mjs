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
  // Tool calls arrive in pieces keyed by index: the name once, the JSON
  // arguments split across many chunks. They are assembled, never streamed.
  const calls = new Map();
  let reasoning = "";
  return {
    get done() { return done; },
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
        if (typeof thought === "string" && thought) reasoning += thought;
        const content = choice?.delta?.content ?? choice?.message?.content;
        if (typeof content === "string" && content) deltas.push(content);
        else if (Array.isArray(content)) {
          const text = content.map((part) => (typeof part === "string" ? part : part?.text ?? "")).join("");
          if (text) deltas.push(text);
        }
        if (choice?.finish_reason) done = true;
      }
      return deltas;
    },
  };
}

/** One server-sent event from Atlas to the browser. */
export function encodeEvent(type, data) {
  return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
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
