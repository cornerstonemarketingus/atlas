import assert from "node:assert/strict";
import test from "node:test";
import { converse } from "../app/api/chat/agent-loop.mjs";
import { TASK_TOOL } from "../app/api/chat/atlas-knowledge.mjs";

const task = { id: "code", type: "function", function: { name: "start_atlas_task", arguments: JSON.stringify({ mode: "coder", objective: "Fix the login bug and run its regression tests", repository: "owner/repo" }) } };
async function run({ stream = false, calls = [task], startTasks, ...overrides } = {}) {
  const trace = [];
  const result = await converse({ endpoint: { baseUrl: "https://model.test/v1", model: "test" }, turns: [{ role: "user", content: "Fix the login bug" }], userMessage: "Fix the login bug", defaultRepository: "owner/repo", stream, emit: () => {}, sleep: async () => {},
    toolContext: { allowlist: new Set(["owner/repo"]), githubToken: async () => "key", fetcher: async () => { trace.push("lookup"); return Response.json({}); } },
    fetcher: async () => {
      trace.push("model");
      if (trace.filter(v => v === "model").length > 1) return new Response(null, { status: 429, headers: { "retry-after": "3600" } });
      if (stream) return new Response(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: calls.map((call, index) => ({ ...call, index })) } }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
      return Response.json({ choices: [{ message: { content: "", tool_calls: calls } }] });
    },
    startTasks: async requests => { trace.push("dispatch"); return startTasks ? startTasks(requests) : ["Started coder task task-123. Progress appears in this conversation."]; }, ...overrides,
  });
  return { result, trace };
}

for (const stream of [false, true]) test(`selected coder dispatch does not depend on another model call (stream=${stream})`, async () => {
  const { result, trace } = await run({ stream, startTasks: async batch => {
    assert.equal(batch.requests[0].mode, "coder");
    assert.equal(batch.requests[0].repository, "owner/repo");
    return ["Started coder task task-123."];
  } });
  assert.deepEqual(trace, ["model", "dispatch"]);
  assert.equal(result.reply, "Started coder task task-123.");
  assert.equal(result.finalization, undefined);
});

test("a selected coder is not held behind read-only work in the same response", async () => {
  const lookup = { id: "read", type: "function", function: { name: "read_repository_file", arguments: JSON.stringify({ repository: "owner/repo", path: "README.md" }) } };
  const { trace } = await run({ calls: [lookup, task] });
  assert.deepEqual(trace, ["model", "dispatch"]);
});

test("task-service refusal is reported without a false start or retry", async () => {
  const { result, trace } = await run({ startTasks: async () => ["I could not start a coder run: repository is not connected."] });
  assert.deepEqual(trace, ["model", "dispatch"]);
  assert.match(result.reply, /could not start/);
  assert.doesNotMatch(result.reply, /Started|Ask me to continue|could not reach a model/i);
});

test("uncertain dispatch is not retried and does not expose exception details", async () => {
  const { result, trace } = await run({ startTasks: async () => { throw new Error("SECRET_TOKEN"); } });
  assert.deepEqual(trace, ["model", "dispatch"]);
  assert.match(result.reply, /could not confirm.*task/i);
  assert.doesNotMatch(result.reply, /SECRET_TOKEN/);
});

test("child and unoffered task tools cannot dispatch", async () => {
  for (const settings of [{ allowTasks: false, tools: [TASK_TOOL] }, { tools: [] }]) {
    const { trace } = await run(settings);
    assert.ok(!trace.includes("dispatch"));
  }
});

test("malformed task arguments are reported without dispatch", async () => {
  const { trace, result } = await run({ calls: [{ ...task, function: { ...task.function, arguments: "{" } }] });
  assert.deepEqual(trace, ["model"]);
  assert.match(result.reply, /unreadable arguments/);
});
