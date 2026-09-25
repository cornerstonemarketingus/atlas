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
 * signalled the end. Reasoning fields are ignored on purpose.
 */
export function createDeltaParser() {
  let buffer = "";
  let done = false;
  return {
    get done() { return done; },
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
