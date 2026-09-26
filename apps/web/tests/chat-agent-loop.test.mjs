import assert from "node:assert/strict";
import test from "node:test";

import { MAX_TOOL_STEPS, converse } from "../app/api/chat/agent-loop.mjs";

const endpoint = { baseUrl: "https://model.test/v1", apiKey: "k", model: "m", provider: "primary", label: "primary:m" };
const sse = (events) => new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
const say = (text) => ({ choices: [{ delta: { content: text } }] });
const callTool = (id, name, args) => ({ choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name, arguments: JSON.stringify(args) } }] } }] });

/** A fake model: answers each request with the next scripted reply, recording what it was sent. */
function scripted(replies) {
  const requests = [];
  const fetcher = async (url, init) => {
    if (!String(url).startsWith("https://model.test")) {
      // The web page an instant tool reads.
      return new Response("<title>Example</title><p>Example body</p>", { headers: { "content-type": "text/html" } });
    }
    requests.push(JSON.parse(init.body));
    const next = replies.shift();
    return typeof next === "function" ? next() : sse(next);
  };
  return { fetcher, requests };
}

function run(fetcher, overrides = {}) {
  const events = [];
  const started = [];
  const promise = converse({
    endpoint,
    turns: [{ role: "system", content: "sys" }, { role: "user", content: "hi" }],
    toolContext: { environment: {}, allowlist: new Set(), githubToken: async () => undefined, fetcher },
    defaultRepository: "cornerstonemarketingus/atlas",
    userMessage: "hi",
    startTasks: async (calls) => { started.push(calls); return calls.requests.map((request) => `Started ${request.mode}.`); },
    stream: true,
    emit: (type, data) => events.push({ type, data }),
    fetcher,
    ...overrides,
  });
  return { promise, events, started };
}

test("a plain answer is one round with the tools offered", async () => {
  const { fetcher, requests } = scripted([[say("Hello "), say("there")]]);
  const { promise, events } = run(fetcher);
  const outcome = await promise;
  assert.deepEqual(outcome, { reply: "Hello there", steps: [], answeredBy: "primary:m" });
  assert.equal(requests.length, 1);
  assert.ok(requests[0].tools.some((tool) => tool.function.name === "read_web_page"));
  assert.equal(requests[0].tool_choice, "auto");
  assert.equal(requests[0].max_tokens, 4096);
  assert.deepEqual(events.filter((event) => event.type === "delta").map((event) => event.data.text), ["Hello ", "there"]);
});

test("Atlas reads a page, sees the result, then answers", async () => {
  const { fetcher, requests } = scripted([
    [say("Let me look."), callTool("t1", "read_web_page", { url: "https://example.com/" })],
    [say("It says Example body.")],
  ]);
  const { promise, events } = run(fetcher);
  const outcome = await promise;
  assert.equal(outcome.reply, "Let me look.\n\nIt says Example body.");
  assert.equal(outcome.answeredBy, "primary:m");
  assert.deepEqual(outcome.steps, [{ label: "Read “Example”", ok: true }]);
  const tools = events.filter((event) => event.type === "tool").map((event) => event.data);
  assert.deepEqual(tools, [{ id: "t1", label: "Reading example.com/…", state: "running" }, { id: "t1", label: "Read “Example”", state: "done" }]);
  const second = requests[1].messages;
  assert.equal(second.at(-2).role, "assistant");
  assert.equal(second.at(-2).tool_calls[0].id, "t1");
  assert.equal(second.at(-1).role, "tool");
  assert.equal(second.at(-1).tool_call_id, "t1");
  assert.match(second.at(-1).content, /<data source="web page https:\/\/example.com\/">[\s\S]*Example body/u);
});

test("tasks the model starts run once, after the reply", async () => {
  const { fetcher } = scripted([[say("Starting it."), callTool("s1", "start_atlas_task", { mode: "coder", objective: "Fix the login bug", repository: "cornerstonemarketingus/atlas" })]]);
  const { promise, started } = run(fetcher);
  const outcome = await promise;
  assert.equal(started.length, 1);
  assert.equal(started[0].requests[0].mode, "coder");
  assert.equal(outcome.reply, "Starting it.\n\nStarted coder.");
  assert.equal(outcome.answeredBy, "primary:m");
});

test("tool use is bounded: the last round must answer in words", async () => {
  const loopForever = Array.from({ length: MAX_TOOL_STEPS }, (_, index) => [callTool(`r${index}`, "read_web_page", { url: "https://example.com/" })]);
  const { fetcher, requests } = scripted([...loopForever, [say("Done looking.")]]);
  const outcome = await run(fetcher).promise;
  assert.equal(requests.length, MAX_TOOL_STEPS + 1);
  assert.equal(requests.at(-1).tool_choice, "none");
  assert.equal(outcome.steps.length, MAX_TOOL_STEPS);
  assert.equal(outcome.reply, "Done looking.");
  assert.equal(outcome.answeredBy, "primary:m");
});

test("an endpoint without tool support is retried without tools", async () => {
  const { fetcher, requests } = scripted([() => new Response("no tools", { status: 400 }), [say("Plain answer.")]]);
  const outcome = await run(fetcher).promise;
  assert.equal(outcome.reply, "Plain answer.");
  assert.equal(outcome.answeredBy, "primary:m");
  assert.ok(requests[0].tools);
  assert.equal(requests[1].tools, undefined);
});

test("model failures become an actionable error", async () => {
  const { fetcher } = scripted([() => new Response("secret prompt echoed", { status: 500 })]);
  assert.deepEqual(await run(fetcher).promise, { error: "The model endpoint answered 500.", status: 502 });
  const down = async () => { throw new TypeError("fetch failed"); };
  assert.equal((await run(down).promise).status, 504);
});

test("non-streaming replies are handled the same way", async () => {
  const json = (body) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  const { fetcher } = scripted([
    () => json({ choices: [{ message: { content: "", tool_calls: [{ id: "n1", type: "function", function: { name: "read_web_page", arguments: "{\"url\":\"https://example.com/\"}" } }] } }] }),
    () => json({ choices: [{ message: { content: "Found it." } }] }),
  ]);
  const outcome = await run(fetcher, { stream: false }).promise;
  assert.equal(outcome.reply, "Found it.");
  assert.equal(outcome.steps.length, 1);
  assert.equal(outcome.answeredBy, "primary:m");
});

test("falls back to the next route when the primary returns 429", async () => {
  const requests = [];
  const routes = [
    { baseUrl: "https://primary.test/v1", apiKey: "one", model: "m1", label: "groq:m1", provider: "groq" },
    { baseUrl: "https://backup.test/v1", apiKey: "two", model: "m2", label: "openai:m2", provider: "openai" },
  ];
  const fetcher = async (url, init) => {
    const target = String(url);
    if (target.startsWith("https://primary.test")) {
      requests.push({ target, body: JSON.parse(init.body) });
      return new Response("rate limited", { status: 429 });
    }
    if (target.startsWith("https://backup.test")) {
      requests.push({ target, body: JSON.parse(init.body) });
      return sse([say("Recovered via fallback.")]);
    }
    return new Response("<title>Example</title><p>Example body</p>", { headers: { "content-type": "text/html" } });
  };
  const outcome = await run(fetcher, { endpoint: undefined, routes }).promise;
  assert.equal(outcome.reply, "Recovered via fallback.");
  assert.equal(outcome.answeredBy, "openai:m2");
  assert.equal(requests.length, 2);
  assert.match(requests[0].target, /primary\.test/u);
  assert.match(requests[1].target, /backup\.test/u);
});
