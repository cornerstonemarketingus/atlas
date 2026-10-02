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

for (const stream of [false, true]) {
  test(`tool-free synthesis repairs a rejected tool call, then uses the permitted fallback (stream=${stream})`, async () => {
    const rejected = () => new Response(JSON.stringify({ error: { code: "tool_use_failed", failed_generation: "private rejected content" } }), { status: 400 });
    const read = { choices: [{ message: { tool_calls: [{ id: "read1", type: "function", function: { name: "read_web_page", arguments: JSON.stringify({ url: "https://example.com" }) } }] } }] };
    const { fetcher, requests } = scripted([
      json(read), json({ choices: [] }), rejected, rejected,
      json({ choices: [{ message: { content: "Verified: Example body." } }] }),
    ]);
    const outcome = await run(fetcher, { stream, endpoint: { ...endpoint, fallbackModel: "small" } }).promise;
    assert.equal(outcome.reply, "Verified: Example body.");
    assert.equal(outcome.steps.length, 1);
    assert.equal(requests.length, 5);
    assert.deepEqual(requests.slice(2).map((request) => request.model), ["m", "m", "small"]);
    for (const request of requests.slice(2)) {
      assert.equal(request.tools, undefined);
      assert.match(JSON.stringify(request.messages), /Example body/);
      assert.doesNotMatch(JSON.stringify(request.messages), /private rejected content/);
    }
    assert.match(requests[3].messages.at(-1).content, /plain text/i);
  });
}

test("tool-free synthesis rejection stays bounded without a fallback and retains completed work", async () => {
  const rejected = () => new Response(JSON.stringify({ error: { code: "tool_use_failed" } }), { status: 400 });
  const { fetcher, requests } = scripted([json({ choices: [] }), rejected, rejected, rejected]);
  const outcome = await run(fetcher, { stream: false }).promise;
  assert.equal(requests.length, 4);
  assert.equal(outcome.finalization.status, "incomplete");
  assert.match(outcome.finalization.reason, /rejected a tool call/);
  assert.ok(outcome.reply.trim());
});

test("unknown HTTP 400 during synthesis is not retried as a rejected tool call", async () => {
  const { fetcher, requests } = scripted([json({ choices: [] }), () => new Response(JSON.stringify({ error: { code: "invalid_request" } }), { status: 400 })]);
  const outcome = await run(fetcher, { stream: false }).promise;
  assert.equal(requests.length, 2);
  assert.match(outcome.finalization.reason, /400/);
});

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

test("a model that hit its length limit with nothing written gets more room at once, not the same wall", async () => {
  const { fetcher, requests } = scripted([
    [finish("length")],
    [say("Answer at last.")],
  ]);
  const outcome = await run(fetcher).promise;
  assert.equal(outcome.reply, "Answer at last.");
  assert.deepEqual(requests.map((request) => request.max_tokens), [2048, 4096]);
  assert.equal(requests[1].reasoning_effort, undefined, "no reasoning was seen, so none is asked to change");
});

// GPT-OSS on Groq: the reasoning uses up max_completion_tokens, HTTP 200 comes back
// with finish_reason "length", reasoning in the stream and no content.
const thinking = (text) => ({ choices: [{ delta: { reasoning: text } }] });

const readPage = (id) => callTool(id, "read_web_page", { url: `https://example.com/${id}` });
const groqUsage = (completion) => ({ choices: [{ delta: {}, finish_reason: "length" }], x_groq: { usage: { prompt_tokens: 5100, completion_tokens: completion, total_tokens: 5100 + completion } } });

test("reasoning exhausted while writing up finished work: low reasoning effort and room for what was spent", async () => {
  const logged = [];
  const original = console.warn;
  console.warn = (line) => logged.push(JSON.parse(String(line)));
  let outcome;
  let requests;
  try {
    const script = scripted([
      [readPage("t1")],
      [thinking("Let me think about this at great length…"), groqUsage(2048)],
      [say("The page says Example body.")],
    ]);
    requests = script.requests;
    outcome = await run(script.fetcher).promise;
  } finally {
    console.warn = original;
  }
  assert.equal(outcome.reply, "The page says Example body.");
  const synthesis = requests.at(-1);
  assert.equal(synthesis.reasoning_effort, "low", "formatting finished work does not need deep reasoning");
  assert.equal(synthesis.max_tokens, 4096);
  assert.ok(requests.slice(0, -1).every((request) => request.reasoning_effort === undefined), "working rounds keep the model's own effort");
  const empty = logged.find((record) => record.event === "inference.empty_response");
  assert.equal(empty.finishReason, "length");
  assert.equal(empty.hadReasoning, true);
  assert.deepEqual(empty.usage, { promptTokens: 5100, completionTokens: 2048, totalTokens: 7148, reasoningTokens: null });
  assert.doesNotMatch(JSON.stringify(logged), /great length/u, "reasoning text is never logged");
});

test("reasoning exhausted on a question with no work yet: full reasoning kept, only the room grows", async () => {
  const { fetcher, requests } = scripted([
    [thinking("hard problem…"), groqUsage(6000)],
    [say("The considered answer.")],
  ]);
  const outcome = await run(fetcher).promise;
  assert.equal(outcome.reply, "The considered answer.");
  assert.equal(requests[1].reasoning_effort, undefined, "difficult analysis keeps its reasoning");
  // 6,000 spent thinking plus room for the answer, within the ceiling.
  assert.equal(requests[1].max_tokens, 8048);
});

test("the same reasoning exhaustion is handled identically without streaming", async () => {
  const json = (body) => () => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  const { fetcher, requests } = scripted([
    json({ choices: [{ message: { content: "", tool_calls: [{ id: "n1", type: "function", function: { name: "read_web_page", arguments: "{\"url\":\"https://example.com/\"}" } }] } }] }),
    json({ choices: [{ message: { content: "", reasoning: "long thought" }, finish_reason: "length" }], usage: { prompt_tokens: 5000, completion_tokens: 2048, total_tokens: 7048, completion_tokens_details: { reasoning_tokens: 2048 } } }),
    json({ choices: [{ message: { content: "Non-streamed answer." } }] }),
  ]);
  const outcome = await run(fetcher, { stream: false }).promise;
  assert.equal(outcome.reply, "Non-streamed answer.");
  assert.equal(requests.at(-1).reasoning_effort, "low");
  assert.equal(requests.at(-1).max_tokens, 4096);
  assert.equal(requests.at(-1).tools, undefined);
});

test("a server that rejects reasoning_effort is asked again without it", async () => {
  const { fetcher, requests } = scripted([
    [readPage("t1")],
    [thinking("hmm"), finish("length")],
    () => new Response(JSON.stringify({ error: { message: "unknown parameter reasoning_effort" } }), { status: 400 }),
    [say("Fine.")],
  ]);
  const outcome = await run(fetcher).promise;
  assert.equal(outcome.reply, "Fine.");
  assert.equal(requests[2].reasoning_effort, "low");
  assert.equal(requests[3].reasoning_effort, undefined);
});

test("empty twice from the configured model: the fallback model writes the answer", async () => {
  const { fetcher, requests } = scripted([[finish("stop")], [finish("stop")], [finish("stop")], [say("From the fallback.")]]);
  const outcome = await run(fetcher, { endpoint: { ...endpoint, fallbackModel: "small" } }).promise;
  assert.equal(outcome.reply, "From the fallback.");
  assert.deepEqual(requests.map((request) => request.model), ["m", "m", "m", "small"]);
});

test("when no model writes the answer, the outcome says so alongside the saved work", async () => {
  const empty = [finish("stop")];
  const { fetcher } = scripted([empty, empty, empty, empty]);
  const outcome = await run(fetcher).promise;
  assert.ok(outcome.reply.length > 0);
  assert.deepEqual(outcome.finalization, { status: "incomplete", reason: "the model returned an empty reply.", completedSteps: 0, failedSteps: 0 });
});

// Groq's answer to one malformed tool call (body shape as Groq returns it).
const toolUseFailed = (name = "repo.search") => () => new Response(JSON.stringify({ error: {
  message: `Tool call validation failed: attempted to call tool '${name}' which was not in request.tools`,
  type: "invalid_request_error", code: "tool_use_failed",
  failed_generation: JSON.stringify({ name, arguments: { query: "secret-looking argument" } }),
} }), { status: 400 });

test("one rejected tool call is corrected, and the conversation keeps its tools", async () => {
  const { fetcher, requests } = scripted([toolUseFailed(), [say("Answered with tools still available.")]]);
  const outcome = await run(fetcher).promise;
  assert.equal(outcome.reply, "Answered with tools still available.");
  assert.equal(requests.length, 2);
  assert.ok(Array.isArray(requests[1].tools) && requests[1].tools.length > 0, "tools are not dropped over one bad call");
  const correction = requests[1].messages.at(-1).content;
  assert.match(correction, /rejected as invalid \('repo\.search'\)/u);
  assert.match(correction, /read_web_page/u);
  assert.doesNotMatch(correction, /secret-looking/u, "the rejected arguments are not replayed");
});

test("a second rejected tool call ends tool use for this reply and synthesis answers", async () => {
  const { fetcher, requests } = scripted([toolUseFailed(), toolUseFailed(), [say("Answer without that tool.")]]);
  const outcome = await run(fetcher).promise;
  assert.equal(outcome.reply, "Answer without that tool.");
  assert.equal(requests.length, 3);
  assert.equal(requests[2].tools, undefined);
});

test("a server that genuinely cannot take tools still gets the request without them", async () => {
  const { fetcher, requests } = scripted([() => new Response("{\"error\":{\"message\":\"tools not supported\"}}", { status: 400 }), [say("Plain answer.")]]);
  const outcome = await run(fetcher).promise;
  assert.equal(outcome.reply, "Plain answer.");
  assert.equal(requests[1].tools, undefined);
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
