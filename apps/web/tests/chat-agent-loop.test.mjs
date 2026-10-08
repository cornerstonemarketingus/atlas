import assert from "node:assert/strict";
import test from "node:test";

import { MAX_TOOL_STEPS, converse, durationMs, retryAfterMs } from "../app/api/chat/agent-loop.mjs";

const endpoint = { baseUrl: "https://model.test/v1", apiKey: "k", model: "m" };
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
    toolContext: { environment: {}, allowlist: new Set(), githubToken: async () => undefined, fetcher: overrides.toolFetcher ?? fetcher },
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
  // The test endpoint is neither Groq nor OpenAI, so it counts as self-hosted.
  assert.deepEqual(outcome, { reply: "Hello there", steps: [], servedBy: { provider: "self-hosted", model: "m" } });
  assert.equal(requests.length, 1);
  assert.ok(requests[0].tools.some((tool) => tool.function.name === "read_web_page"));
  assert.equal(requests[0].tool_choice, "auto");
  assert.equal(requests[0].max_tokens, 2048);
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
  assert.deepEqual(outcome.steps, [{ label: "Read “Example”", ok: true }]);
  const tools = events.filter((event) => event.type === "tool").map((event) => event.data);
  assert.deepEqual(tools.map(({ id, label, state }) => ({ id, label, state })), [{ id: "t1", label: "Reading example.com/…", state: "running" }, { id: "t1", label: "Read “Example”", state: "done" }]);
  // The finished step carries a preview of the page for the Files panel.
  assert.equal(tools[1].preview.kind, "page");
  assert.match(tools[1].preview.content, /Example body/u);
  const second = requests[1].messages;
  assert.equal(second.at(-2).role, "assistant");
  assert.equal(second.at(-2).tool_calls[0].id, "t1");
  assert.equal(second.at(-1).role, "tool");
  assert.equal(second.at(-1).tool_call_id, "t1");
  assert.match(second.at(-1).content, /<data source="web page https:\/\/example.com\/">[\s\S]*Example body/u);
});

test("tasks the model selects dispatch once with its introduction", async () => {
  const { fetcher } = scripted([[say("Starting it."), callTool("s1", "start_atlas_task", { mode: "coder", objective: "Fix the login bug", repository: "cornerstonemarketingus/atlas" })]]);
  const { promise, started } = run(fetcher);
  const outcome = await promise;
  assert.equal(started.length, 1);
  assert.equal(started[0].requests[0].mode, "coder");
  assert.equal(outcome.reply, "Starting it.\n\nStarted coder.");
});

test("tool use is bounded: the last round must answer in words", async () => {
  const loopForever = Array.from({ length: MAX_TOOL_STEPS }, (_, index) => [callTool(`r${index}`, "read_web_page", { url: "https://example.com/" })]);
  const { fetcher, requests } = scripted([...loopForever, [say("Done looking.")]]);
  const outcome = await run(fetcher).promise;
  assert.equal(requests.length, MAX_TOOL_STEPS + 1);
  assert.equal(requests.at(-1).tool_choice, "none");
  assert.equal(outcome.steps.length, MAX_TOOL_STEPS);
  assert.equal(outcome.reply, "Done looking.");
});

test("an endpoint without tool support is retried without tools", async () => {
  const { fetcher, requests } = scripted([() => new Response("no tools", { status: 400 }), [say("Plain answer.")]]);
  const outcome = await run(fetcher).promise;
  assert.equal(outcome.reply, "Plain answer.");
  assert.ok(requests[0].tools);
  assert.equal(requests[1].tools, undefined);
});

test("model failures become an actionable error", async () => {
  const failing = () => new Response("secret prompt echoed", { status: 500 });
  const { fetcher, requests } = scripted([failing, failing, failing]);
  const waits = [];
  assert.deepEqual(await run(fetcher, { sleep: async (ms) => { waits.push(ms); } }).promise, {
    error: "The model endpoint answered 500.", status: 502,
    inferenceFailure: { status: 500, provider: "self-hosted", model: "m", category: "SERVER_ERROR", round: 0 },
  });
  // A 5xx is retried a bounded number of times, never looped on.
  assert.equal(requests.length, 3);
  assert.equal(waits.length, 2);
  const unauthorized = scripted([() => new Response("", { status: 401 })]);
  assert.equal((await run(unauthorized.fetcher, { sleep: async () => {} }).promise).status, 502);
  // A 401 is configuration, not load: asking again cannot help.
  assert.equal(unauthorized.requests.length, 1);
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
});

test("a 429 waits what the provider asks, retries, then falls back to the second model", async () => {
  const waits = [];
  const limited = () => new Response("slow down", { status: 429, headers: { "retry-after": "1" } });
  const { fetcher, requests } = scripted([limited, limited, [say("From the fallback.")]]);
  const outcome = await run(fetcher, { endpoint: { ...endpoint, fallbackModel: "small" }, sleep: async (ms) => { waits.push(ms); } }).promise;
  assert.equal(outcome.reply, "From the fallback.");
  assert.deepEqual(waits, [1000]);
  assert.deepEqual(requests.map((request) => request.model), ["m", "m", "small"]);
});

test("a long retry-after skips straight to the fallback; no fallback means a clear 429 error", async () => {
  const limited = () => new Response("", { status: 429, headers: { "retry-after": "60" } });
  const waits = [];
  const withFallback = scripted([limited, [say("ok")]]);
  assert.equal((await run(withFallback.fetcher, { endpoint: { ...endpoint, fallbackModel: "small" }, sleep: async (ms) => { waits.push(ms); } }).promise).reply, "ok");
  assert.deepEqual(waits, []);
  // With nowhere to route, a per-minute reset is waited out (twice at most), not given up on at once.
  const without = scripted([limited, limited, limited]);
  const slept = [];
  const failed = await run(without.fetcher, { sleep: async (ms) => { slept.push(ms); } }).promise;
  assert.deepEqual(slept, [60_000, 60_000]);
  assert.equal(failed.status, 429);
  assert.match(failed.error, /rate limit was reached \(429\): m \(model\.test\) is rate-limited for about 60 s/u);
});

test("a reset longer than about a minute (a daily quota) is not waited for, and the error says when it ends", async () => {
  const daily = () => new Response("", { status: 429, headers: { "retry-after": "600" } });
  const slept = [];
  const failed = await run(scripted([daily]).fetcher, { sleep: async (ms) => { slept.push(ms); } }).promise;
  assert.deepEqual(slept, []);
  assert.equal(failed.status, 429);
  assert.match(failed.error, /m \(model\.test\) is rate-limited for about 10 min/u);
});

test("refusals name each model and a fixed reason, never the provider's text", async () => {
  const { describeRefusals } = await import("../app/api/chat/agent-loop.mjs");
  assert.equal(describeRefusals([
    { model: "big", host: "api.groq.com", status: 429, category: "rate_limit", retryAfterMs: 40_000 },
    { model: "big", host: "api.groq.com", status: 429, category: "rate_limit", retryAfterMs: 30_000 },
    { model: "gpt-5.4-mini", host: "api.openai.com", status: 429, category: "billing", retryAfterMs: null },
    { model: "small", host: "api.groq.com", status: 503, category: "unavailable", retryAfterMs: null },
    { model: "x", host: "h", status: 429, category: "input_too_large", retryAfterMs: 1 },
    { model: "y", host: "h", status: 429, category: "rate_limit", retryAfterMs: 3 * 3_600_000 },
  ]), "big (api.groq.com) is rate-limited for about 30 s; gpt-5.4-mini (api.openai.com) has no API credits or reached a billing limit; small (api.groq.com) answered 503; x (h) refused a request larger than its per-minute token allowance; y (h) is rate-limited for about 3 h");
  assert.equal(describeRefusals([]), "");
});

test("a Groq minute-long wait in the body or reset header goes to the fallback instead of retrying into it", async () => {
  const inBody = () => new Response(JSON.stringify({ error: { message: "Rate limit reached on tokens per day (TPD). Please try again in 7m12.5s." } }), { status: 429 });
  const inHeader = () => new Response("", { status: 429, headers: { "x-ratelimit-reset-tokens": "1m2.5s" } });
  for (const limited of [inBody, inHeader]) {
    const waits = [];
    const { fetcher, requests } = scripted([limited, [say("ok")]]);
    const outcome = await run(fetcher, { endpoint: { ...endpoint, fallbackModel: "small" }, sleep: async (ms) => { waits.push(ms); } }).promise;
    assert.equal(outcome.reply, "ok");
    assert.deepEqual(waits, []);
    assert.deepEqual(requests.map((request) => request.model), ["m", "small"]);
  }
});

test("reads Groq's durations", () => {
  assert.equal(durationMs("2m59.56s"), 179_560);
  assert.equal(durationMs("340ms"), 340);
  assert.equal(durationMs("later"), null);
  assert.equal(retryAfterMs(new Headers(), "Please try again in 1.5s."), 1_500);
  assert.equal(retryAfterMs(new Headers({ "retry-after": "2" }), "Please try again in 9s."), 2_000);
});

test("a rate limit after some work waits, then writes the answer from the work", async () => {
  const limited = () => new Response("", { status: 429, headers: { "retry-after": "3" } });
  const waits = [];
  const { fetcher, requests } = scripted([
    [say("Checking the page."), callTool("t1", "read_web_page", { url: "https://example.com/" })],
    limited, // the round after the tool: refused
    limited, // synthesis, first try: refused
    [say("The page says Example body.")],
  ]);
  const outcome = await run(fetcher, { sleep: async (ms) => { waits.push(ms); } }).promise;
  assert.equal(outcome.reply, "Checking the page.\n\nThe page says Example body.");
  assert.equal(outcome.steps.length, 1);
  // The synthesis call carries the work and cannot start another tool cycle.
  const synthesis = requests.at(-1);
  assert.equal(synthesis.tools, undefined);
  assert.match(synthesis.messages.at(-1).content, /Example body/u);
  assert.match(synthesis.messages.at(-1).content, /rate limit/u);
  assert.ok(waits.includes(3000));
});

test("when no model can answer at all, the work is still the reply, never an empty one", async () => {
  const limited = () => new Response("", { status: 429, headers: { "retry-after": "600" } });
  const { fetcher } = scripted([[say("Checking the page."), callTool("t1", "read_web_page", { url: "https://example.com/" })], limited, limited]);
  const outcome = await run(fetcher, { sleep: async () => {} }).promise;
  assert.match(outcome.reply, /^Checking the page\.\n\nI could not reach a model/u);
  assert.match(outcome.reply, /Example/u);
  assert.match(outcome.reply, /rate limit/u);
  assert.match(outcome.reply, /Ask me to continue/u);
});

test("older tool results are shortened before later rounds", async () => {
  const big = "x".repeat(5000);
  const { fetcher, requests } = scripted([
    [callTool("t1", "read_web_page", { url: "https://example.com/" })],
    [callTool("t2", "read_web_page", { url: "https://example.com/b" })],
    [say("done")],
  ]);
  const bigPage = async () => new Response(`<p>${big}</p>`, { headers: { "content-type": "text/html" } });
  await run(fetcher, { toolFetcher: bigPage }).promise;
  const third = requests[2].messages.filter((message) => message.role === "tool");
  assert.match(third[0].content, /already read; shortened\)\n<\/data>$/u);
  assert.ok(third[1].content.length > 5000);
});
