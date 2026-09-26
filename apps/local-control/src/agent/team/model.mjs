/**
 * One model turn, collected: the streamed text, any tool calls, and usage.
 */
export async function completeTurn(client, request) {
  let text = "";
  const toolCalls = [];
  let usage = null;
  for await (const chunk of client.stream(request)) {
    if (chunk.type === "text") text += chunk.delta;
    else if (chunk.type === "tool_call") toolCalls.push(chunk);
    else if (chunk.type === "done") usage = chunk.usage ?? null;
  }
  return { text: stripReasoning(text).trim(), toolCalls, usage };
}

/** Reasoning models may inline their thinking; it never becomes output. */
function stripReasoning(text) {
  return text.replace(/<think>[\s\S]*?<\/think>/giu, "");
}

/** Parses the first JSON object in a reply, tolerating code fences. */
export function parseJsonReply(text) {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/iu.exec(text);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end <= start) throw Object.assign(new Error("The model did not return a JSON object."), { code: "MODEL_OUTPUT_INVALID" });
  try { return JSON.parse(candidate.slice(start, end + 1)); }
  catch { throw Object.assign(new Error("The model returned malformed JSON."), { code: "MODEL_OUTPUT_INVALID" }); }
}

export function tokenUsage(usage, fallbackIn = 0, fallbackOut = 0) {
  return {
    inputTokens: Number.isInteger(usage?.prompt_tokens) ? usage.prompt_tokens : fallbackIn,
    outputTokens: Number.isInteger(usage?.completion_tokens) ? usage.completion_tokens : fallbackOut,
  };
}
