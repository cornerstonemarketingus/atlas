import assert from "node:assert/strict";
import test from "node:test";
import { converse } from "../app/api/chat/agent-loop.mjs";

for (const stream of [false, true]) {
  for (const fallback of [false, true]) {
    for (const hasText of [false, true]) {
      test(`task dispatch keeps honest model authorship: stream=${stream}, fallback=${fallback}, text=${hasText}`, async () => {
        const endpoint = {
          baseUrl: "https://model.test/v1/", model: "primary", apiKey: "fixture",
          ...(fallback ? { providerFallback: { configured: true, baseUrl: "https://api.groq.com/openai/v1/", model: "fallback", apiKey: "other-fixture" } } : {}),
        };
        const tool = { id: "dispatch1", type: "function", function: {
          name: "start_atlas_task", arguments: JSON.stringify({ repository: "cornerstonemarketingus/atlas", mode: "inspect", objective: "Inspect repository manifests." }),
        } };
        const requests = [];
        const fetcher = async (url) => {
          requests.push(new URL(url).hostname);
          if (fallback && new URL(url).hostname === "model.test") return Response.json({ error: { message: "Unavailable" } }, { status: 503 });
          const content = hasText ? "I will inspect the repository." : "";
          if (!stream) return Response.json({ choices: [{ message: { content, tool_calls: [tool] }, finish_reason: "tool_calls" }] });
          return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content, tool_calls: [{ ...tool, index: 0 }] }, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
        };
        let dispatched = 0;
        const result = await converse({
          endpoint, turns: [{ role: "user", content: "Inspect the repository." }],
          defaultRepository: "cornerstonemarketingus/atlas", userMessage: "Inspect the repository.",
          toolContext: { environment: {}, allowlist: new Set(), githubToken: async () => undefined, fetcher },
          startTasks: async (batch) => { dispatched += batch.requests.length; return ["Inspection started."]; },
          stream, emit: () => {}, fetcher, sleep: async () => {},
        });
        assert.equal(dispatched, 1);
        assert.match(result.reply, /Inspection started\./u);
        assert.deepEqual(result.steps, []);
        assert.equal(result.finalization, undefined);
        assert.deepEqual(result.servedBy, hasText ? { provider: fallback ? "groq" : "self-hosted", model: fallback ? "fallback" : "primary" } : undefined);
        assert.equal(requests.includes("api.groq.com"), fallback);
      });
    }
  }
}
