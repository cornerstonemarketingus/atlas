import { createServer } from "node:http";

/**
 * A stand-in for a local model server (Ollama / llama.cpp / vLLM all speak
 * this OpenAI-compatible protocol). It lets tests drive Atlas's real coder
 * CLI end to end (the spawn, the tool loop, the edits, the coder's own
 * verification) with scripted, deterministic answers instead of a model.
 *
 * `decide({ objective, messages, turn })` returns either
 *   { edits: [{ path, content }], say?: string }  → one propose_change_set call
 *   { say: string }                               → a final answer
 * It is called for each chat request; `turn` counts requests in the current
 * conversation (a new conversation starts when there is no tool message yet).
 */
export async function startScriptedModelServer(decide) {
  const requests = [];
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const send = (status, value) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value)); };
    if (request.method === "GET" && url.pathname === "/v1/models") return send(200, { object: "list", data: [{ id: "scripted-coder", object: "model" }] });
    if (request.method !== "POST" || url.pathname !== "/v1/chat/completions") return send(404, { error: { message: "not found" } });
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const messages = body.messages ?? [];
    const text = (message) => (typeof message.content === "string" ? message.content : Array.isArray(message.content) ? message.content.map((part) => part.text ?? "").join("") : "");
    const objective = messages.filter((m) => m.role === "user").map(text).join("\n\n");
    const turn = messages.filter((m) => m.role === "tool").length;
    requests.push({ model: body.model, turn, objective: objective.slice(0, 4000), tools: (body.tools ?? []).map((t) => t.function?.name) });
    const decision = await decide({ objective, messages, turn });
    const message = decision.edits?.length
      ? {
        role: "assistant",
        content: decision.say ?? null,
        tool_calls: [{
          id: `call_${requests.length}`,
          type: "function",
          function: {
            name: "repository.propose_change_set",
            arguments: JSON.stringify({ edits: decision.edits.map((edit) => ({ operation: edit.operation ?? "update", path: edit.path, ...(edit.content !== undefined ? { content: edit.content } : {}) })) }),
          },
        }],
      }
      : { role: "assistant", content: decision.say ?? "Done." };
    return send(200, {
      id: `chatcmpl-${requests.length}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: body.model,
      choices: [{ index: 0, message, finish_reason: message.tool_calls ? "tool_calls" : "stop" }],
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
