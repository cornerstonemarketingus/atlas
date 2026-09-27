import assert from "node:assert/strict";
import test from "node:test";

import { MAX_TOOL_STEPS, converse } from "../app/api/chat/agent-loop.mjs";
import { plannerClient } from "../app/api/chat/agent-team.mjs";
import { createDeltaParser } from "../app/api/chat/stream.mjs";

// Production answered "The model endpoint returned an empty reply." after
// real work had been done. A turn must end in words: these are the ways it
// could end with reply === "", each pinned.

const endpoint = { baseUrl: "https://model.test/v1", apiKey: "k", model: "m" };
const sse = (events, { trailingNewline = true } = {}) => {
  const body = events.map((event) => `data: ${JSON.stringify(event)}`).join("\n\n");
  return new Response(`${body}${trailingNewline ? "\n\n" : ""}`, { headers: { "content-type": "text/event-stream" } });
};
const json = (body) => () => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
const say = (text) => ({ choices: [{ delta: { content: text } }] });
const callTool = (id, name, args) => ({ choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name, arguments: JSON.stringify(args) } }] } }] });
const finish = (reason) => ({ choices: [{ delta: {}, finish_reason: reason }] });

function scripted(replies) {
  const requests = [];
  const fetcher = async (url, init) => {
    if (!String(url).startsWith("https://model.test")) {
      return new Response("<title>Example</title><p>Example body</p>", { headers: { "content-type": "text/html" } });
    }
    requests.push(JSON.parse(init.body));
    const next = replies.shift();
    if (next === undefined) throw new Error("the model was called more times than scripted");
    return typeof next === "function" ? next() : sse(next);
  };
  return { fetcher, requests };
}

function run(fetcher, overrides = {}) {
  const events = [];
  const promise = converse({
    endpoint,
    turns: [{ role: "system", content: "sys" }, { role: "user", content: "what does the page say?" }],
    toolContext: { environment: {}, allowlist: new Set(), githubToken: async () => undefined, fetcher },
    defaultRepository: "cornerstonemarketingus/atlas",
    userMessage: "what does the page say?",
    startTasks: async (calls) => calls.requests.map((request) => `Started ${request.mode}.`),
    stream: true,
    emit: (type, data) => events.push({ type, data }),
    fetcher,
    sleep: async () => {},
    ...overrides,
  });
  return { promise, events };
}

for (const [name, empty] of [
  ["no choices", json({ choices: [] })],
  ["null content", json({ choices: [{ message: { content: null }, finish_reason: "stop" }] })],
  ["whitespace content", json({ choices: [{ message: { content: "  \n " }, finish_reason: "stop" }] })],
  ["an unparseable body", () => new Response("not json", { headers: { "content-type": "application/json" } })],
]) {
  test(`an empty HTTP 200 (${name}) is not an answer: Atlas asks again without tools`, async () => {
    const { fetcher, requests } = scripted([empty, json({ choices: [{ message: { content: "Here is the answer." } }] })]);
    const outcome = await run(fetcher, { stream: false }).promise;
    assert.equal(outcome.reply, "Here is the answer.");
    assert.equal(requests.length, 2);
    assert.equal(requests[1].tools, undefined);
    // The original conversation is resent unchanged, so the provider's prompt cache still matches it.
    assert.deepEqual(requests[1].messages.slice(0, 2), requests[0].messages);
  });
}

test("streamed text followed by an empty metadata chunk is a normal answer", async () => {
  const { fetcher, requests } = scripted([[say("All "), say("good."), { choices: [], usage: { prompt_tokens: 5 } }, finish("stop")]]);
  const outcome = await run(fetcher).promise;
  assert.equal(outcome.reply, "All good.");
  assert.equal(requests.length, 1);
});

test("a last stream event without a trailing newline is not lost", () => {
  const parser = createDeltaParser();
  const pushed = parser.push(`data: ${JSON.stringify(say("Hello"))}\n\ndata: ${JSON.stringify({ choices: [{ delta: { content: " world" }, finish_reason: "stop" }] })}`);
  assert.deepEqual(pushed, ["Hello"]);
  assert.deepEqual(parser.finish(), [" world"]);
  assert.equal(parser.finishReason, "stop");
});

test("a streamed reply whose final chunk lacks a newline still arrives", async () => {
  const { fetcher } = scripted([() => sse([say("Complete answer.")], { trailingNewline: false })]);
  assert.equal((await run(fetcher).promise).reply, "Complete answer.");
});

test("a tool call on the final allowed round leads to a synthesis, not silence", async () => {
  const lookup = (id) => [callTool(id, "read_web_page", { url: `https://example.com/${id}` })];
  const script = [];
  for (let round = 0; round <= MAX_TOOL_STEPS; round += 1) script.push(lookup(`t${round}`));
  script.push([say("From everything I read: Example body.")]);
  const { fetcher, requests } = scripted(script);
  const outcome = await run(fetcher).promise;
  assert.equal(outcome.reply, "From everything I read: Example body.");
  assert.equal(outcome.steps.length, MAX_TOOL_STEPS);
  assert.equal(requests.length, MAX_TOOL_STEPS + 2);
  assert.equal(requests.at(-1).tools, undefined);
  assert.match(requests.at(-1).messages.at(-1).content, /Completed steps/u);
});

test("a reasoning model that spent its budget thinking gets more room, not the same wall", async () => {
  const { fetcher, requests } = scripted([
    [finish("length")],
    [finish("length")],
    [say("Answer at last.")],
  ]);
  const outcome = await run(fetcher).promise;
  assert.equal(outcome.reply, "Answer at last.");
  assert.deepEqual(requests.map((request) => request.max_tokens), [2048, 2048, 4096]);
});

test("a model that never answers is bounded and still yields a non-empty reply", async () => {
  const empty = [finish("stop")];
  const { fetcher, requests } = scripted([empty, empty, empty, empty, empty, empty]);
  const outcome = await run(fetcher).promise;
  assert.ok(outcome.reply.trim().length > 0);
  // One tool round plus three synthesis attempts, then it stops.
  assert.equal(requests.length, 4);
});

test("the fallback model's empty reply is recovered like any other", async () => {
  const limited = () => new Response("", { status: 429, headers: { "retry-after": "60" } });
  const { fetcher, requests } = scripted([limited, [finish("stop")], [say("Recovered.")]]);
  const outcome = await run(fetcher, { endpoint: { ...endpoint, fallbackModel: "small" } }).promise;
  assert.equal(outcome.reply, "Recovered.");
  assert.deepEqual(requests.map((request) => request.model), ["m", "small", "m"]);
});

test("an agent team's results reach the answer even when the lead's next turn is empty", async () => {
  const team = Object.assign(async () => ({ ok: true, label: "Agent team finished: 3/3 steps verified", content: "<data>auth lives in session.ts</data>" }), { pending: "Handing this to an agent team…" });
  const tools = [{ type: "function", function: { name: "run_agent_team", description: "team", parameters: { type: "object", properties: {} } } }];
  const { fetcher, requests } = scripted([
    [callTool("team1", "run_agent_team", { goal: "audit auth" })],
    [finish("stop")],
    [say("The team found auth in session.ts.")],
  ]);
  const outcome = await run(fetcher, { tools, handlers: { run_agent_team: team } }).promise;
  assert.equal(outcome.reply, "The team found auth in session.ts.");
  assert.match(requests.at(-1).messages.at(-1).content, /auth lives in session\.ts/u);
});

test("a task-only reply gets words, then the started runs", async () => {
  const { fetcher } = scripted([
    [callTool("s1", "start_atlas_task", { mode: "coder", objective: "Fix the login bug", repository: "cornerstonemarketingus/atlas" })],
    [say("Starting that now.")],
  ]);
  const outcome = await run(fetcher).promise;
  assert.match(outcome.reply, /^Starting that now\.\n\nStarted /u);
});

test("a child agent's report is never empty either", async () => {
  const { fetcher } = scripted([[finish("stop")], [say("Report: nothing found in src/.")]]);
  const outcome = await run(fetcher, { allowTasks: false, tools: [], maxRounds: 4, agentId: "a1" }).promise;
  assert.equal(outcome.reply, "Report: nothing found in src/.");
});

test("diagnostics carry facts, never prompts, keys or the endpoint URL", async () => {
  const logged = [];
  const original = console.warn;
  console.warn = (line) => logged.push(String(line));
  try {
    const { fetcher } = scripted([[finish("length")], [say("ok")]]);
    await run(fetcher, { endpoint: { ...endpoint, apiKey: "sk-live-secret" } }).promise;
  } finally {
    console.warn = original;
  }
  const records = logged.map((line) => JSON.parse(line));
  const empty = records.find((record) => record.event === "inference.empty_response");
  assert.ok(empty);
  assert.equal(empty.finishReason, "length");
  assert.equal(empty.contentLength, 0);
  assert.equal(empty.toolCallCount, 0);
  assert.equal(empty.provider, "model.test");
  assert.equal(empty.streaming, true);
  assert.ok(records.some((record) => record.event === "inference.finalizing"));
  const text = logged.join("\n");
  assert.doesNotMatch(text, /sk-live-secret|what does the page say|https:\/\//u);
});

test("the planner's client asks again on an empty reply instead of feeding \"\" to the planner", async () => {
  const replies = [json({ choices: [{ message: { content: "" }, finish_reason: "length" }] }), json({ choices: [{ message: { content: "{\"ok\":true}" } }] })];
  const sent = [];
  const client = plannerClient(endpoint, async (_url, init) => { sent.push(JSON.parse(init.body)); return replies.shift()(); });
  let text = "";
  for await (const chunk of client.stream({ messages: [{ role: "user", content: "plan" }], maxOutputTokens: 300 })) if (chunk.type === "text") text += chunk.delta;
  assert.equal(text, "{\"ok\":true}");
  assert.deepEqual(sent.map((body) => body.max_tokens), [300, 600]);

  const alwaysEmpty = plannerClient(endpoint, async () => json({ choices: [] })());
  await assert.rejects(async () => { for await (const chunk of alwaysEmpty.stream({ messages: [] })) void chunk; }, (error) => error.code === "EMPTY_MODEL_RESPONSE");
});
