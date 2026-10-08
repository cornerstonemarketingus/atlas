import test from "node:test";
import assert from "node:assert/strict";
import { converse } from "../app/api/chat/agent-loop.mjs";

const tool = { type: "function", function: { name: "lookup", description: "Read evidence", parameters: { type: "object", properties: {} } } };
const endpoint = { baseUrl: "https://model.example/v1", model: "test-model" };
const completion = (message, stream) => stream
  ? new Response("data: " + JSON.stringify({ choices: [{ delta: message }] }) + "\n\ndata: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } })
  : Response.json({ choices: [{ message, finish_reason: "stop" }] });

for (const stream of [false, true]) {
  for (const status of [400, 422]) {
    test(`recovers ${status} after tool work (stream=${stream})`, async () => {
      const requests = [];
      const events = [];
      const result = await converse({
        endpoint, turns: [{ role: "user", content: "Find the evidence and explain it." }],
        stream, emit: (type, data) => events.push({ type, data }), allowTasks: false,
        tools: [tool], handlers: { lookup: async () => ({ ok: true, label: "Read evidence", content: "Verified result: example evidence." }) },
        fetcher: async (_url, options) => {
          const body = JSON.parse(options.body);
          requests.push(body);
          if (requests.length === 1) return completion({ content: null, tool_calls: [{ id: "lookup-1", type: "function", function: { name: "lookup", arguments: "{}" } }] }, stream);
          if (body.messages.some(turn => turn.role === "tool")) return Response.json({ error: { message: "Unsupported tool transcript" } }, { status });
          assert.equal(body.tools, undefined);
          assert.ok(JSON.stringify(body.messages).includes("Verified result: example evidence."));
          return completion({ content: "The evidence confirms the example." }, stream);
        },
      });
      assert.equal(result.reply, "The evidence confirms the example.");
      assert.equal(result.finalization, undefined);
      assert.deepEqual(result.steps, [{ label: "Read evidence", ok: true }]);
      assert.ok(events.some(event => event.type === "delta" && event.data.text.includes("confirms")));
      assert.equal(requests.length, 4);
    });
  }
  for (const status of [401, 403]) {
    test(`marks credential refusal incomplete without retry (status=${status}, stream=${stream})`, async () => {
      let calls = 0;
      const result = await converse({
        endpoint, turns: [{ role: "user", content: "Read evidence." }], stream, emit: () => {}, allowTasks: false,
        tools: [tool], handlers: { lookup: async () => ({ ok: true, label: "Read evidence", content: "Evidence" }) },
        fetcher: async () => ++calls === 1
          ? completion({ content: null, tool_calls: [{ id: "lookup-1", type: "function", function: { name: "lookup", arguments: "{}" } }] }, stream)
          : Response.json({ error: { message: "Credential refused" } }, { status }),
      });
      assert.equal(calls, 2);
      assert.equal(result.finalization.status, "incomplete");
      assert.equal(result.finalization.completedSteps, 1);
      assert.equal(result.finalization.failedSteps, 0);
    });
  }
}
