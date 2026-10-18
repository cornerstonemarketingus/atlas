import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createGateway } from "./model-gateway.mjs";

const token = "test-only-".repeat(5);
const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };

async function serve(t, options) {
  const server = createGateway({ token, model: "test-model", ...options });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const chat = (body, init = {}) => fetch(`${base}/v1/chat/completions`, { method: "POST", headers, body: JSON.stringify({ model: "test-model", messages: [{ role: "user", content: "hi" }], ...body }), ...init });
  return { base, chat };
}

/** A model server whose replies the test releases one at a time. */
function gatedModel() {
  const seen = [];
  const gates = [];
  const fetcher = async (url, init) => {
    seen.push({ url, body: JSON.parse(init.body) });
    await new Promise((resolve) => gates.push(resolve));
    return Response.json({ choices: [{ message: { content: `reply ${seen.length}` } }] });
  };
  const openNext = async () => { while (!gates.length) await new Promise((resolve) => setTimeout(resolve, 5)); gates.shift()(); };
  return { fetcher, seen, openNext };
}

test("gateway requires authentication, blocks management, and forwards only inference fields", async (t) => {
  const seen = [];
  const { base, chat } = await serve(t, { models: "test-model, second-model", fetcher: async (url, init) => { seen.push({ url, body: JSON.parse(init.body) }); return Response.json({ choices: [{ message: { content: "hello" } }] }); } });
  assert.equal((await fetch(`${base}/v1/models`)).status, 401);
  assert.equal((await fetch(`${base}/v1/models`, { headers: { authorization: `Bearer ${"x".repeat(token.length)}` } })).status, 401);
  assert.deepEqual((await (await fetch(`${base}/v1/models`, { headers })).json()).data.map((entry) => entry.id), ["test-model", "second-model"]);
  for (const route of ["/api/pull", "/api/delete", "/api/create", "/api/chat"]) assert.equal((await fetch(`${base}${route}`, { method: "POST", headers })).status, 404, route);
  assert.equal((await chat({ model: "other" })).status, 400);
  assert.equal((await chat({ messages: [] })).status, 400);
  assert.equal((await chat({ tools: "not a list" })).status, 400);

  const tools = [{ type: "function", function: { name: "read_web_page", parameters: { type: "object", properties: {} } } }];
  const response = await chat({ max_tokens: 99999, tools, tool_choice: "auto", temperature: 0.1, keep_alive: -1, options: { num_gpu: 99 } });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).choices[0].message.content, "hello");
  assert.equal(seen[0].url, "http://127.0.0.1:11434/v1/chat/completions");
  assert.equal(seen[0].body.max_tokens, 8192, "clamped");
  assert.deepEqual(seen[0].body.tools, tools, "tools reach the model");
  assert.equal(seen[0].body.tool_choice, "auto");
  assert.equal(seen[0].body.keep_alive, undefined, "unknown fields are dropped");
  assert.equal(seen[0].body.options, undefined);
  assert.equal(seen[0].body.stream, false);

  assert.equal((await chat({ model: "second-model" })).status, 200, "any listed model");
  assert.equal(seen[1].body.max_tokens, 8192, "a default ceiling when none is asked for");
  await chat({ max_completion_tokens: 300 });
  assert.equal(seen[2].body.max_completion_tokens, 300);
  assert.equal(seen[2].body.max_tokens, undefined);
});

test("streaming replies pass through as server-sent events", async (t) => {
  const seen = [];
  const events = ['data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n', 'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n', "data: [DONE]\n\n"];
  const { chat } = await serve(t, {
    fetcher: async (_url, init) => {
      seen.push(JSON.parse(init.body));
      const body = new ReadableStream({ start(controller) { for (const event of events) controller.enqueue(new TextEncoder().encode(event)); controller.close(); } });
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    },
  });
  const response = await chat({ stream: true, stream_options: { include_usage: true } });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/event-stream/u);
  assert.equal(await response.text(), events.join(""));
  assert.equal(seen[0].stream, true);
  assert.deepEqual(seen[0].stream_options, { include_usage: true });
});

test("requests beyond the machine's capacity wait their turn; a full queue or a long wait answers 429 with retry-after", async (t) => {
  const model = gatedModel();
  const { chat } = await serve(t, { fetcher: model.fetcher, concurrency: 1, queueLimit: 1, queueWaitMs: 5_000 });
  const first = chat({});
  while (model.seen.length < 1) await new Promise((resolve) => setTimeout(resolve, 5));
  const second = chat({});
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(model.seen.length, 1, "the second waits for the first");
  const third = await chat({});
  assert.equal(third.status, 429, "the queue holds one");
  assert.equal(third.headers.get("retry-after"), "5");
  await model.openNext();
  assert.equal((await (await first).json()).choices[0].message.content, "reply 1");
  await model.openNext();
  assert.equal((await (await second).json()).choices[0].message.content, "reply 2", "then it runs");

  const slow = gatedModel();
  const { chat: chatSlow } = await serve(t, { fetcher: slow.fetcher, concurrency: 1, queueWaitMs: 50 });
  const busy = chatSlow({});
  while (slow.seen.length < 1) await new Promise((resolve) => setTimeout(resolve, 5));
  const expired = await chatSlow({});
  assert.equal(expired.status, 429, "a wait that runs out");
  await slow.openNext();
  assert.equal((await busy).status, 200);
});

test("a caller who leaves while queued does not hold a slot", async (t) => {
  const model = gatedModel();
  const { chat } = await serve(t, { fetcher: model.fetcher, concurrency: 1, queueLimit: 4, queueWaitMs: 5_000 });
  const first = chat({});
  while (model.seen.length < 1) await new Promise((resolve) => setTimeout(resolve, 5));
  const leaving = new AbortController();
  const abandoned = chat({}, { signal: leaving.signal }).catch((error) => error);
  await new Promise((resolve) => setTimeout(resolve, 30));
  leaving.abort();
  await abandoned;
  const third = chat({});
  await new Promise((resolve) => setTimeout(resolve, 30));
  await model.openNext();
  assert.equal((await first).status, 200);
  await model.openNext();
  assert.equal((await third).status, 200);
  assert.equal(model.seen.length, 2, "the abandoned request never reached the model");
});

test("the model server's refusals go back as they are; its failures are not detailed", async (t) => {
  let status = 400;
  const { chat } = await serve(t, { fetcher: async () => new Response(JSON.stringify({ error: { message: "model does not support tools" } }), { status, headers: { "content-type": "application/json" } }) });
  const refused = await chat({});
  assert.equal(refused.status, 400, "Atlas can retry without tools");
  assert.match(await refused.text(), /does not support tools/u);
  status = 500;
  const failed = await chat({});
  assert.equal(failed.status, 502);
  assert.doesNotMatch(await failed.text(), /does not support/u);

  const { chat: chatDown } = await serve(t, { fetcher: async () => { throw new Error("connect ECONNREFUSED"); } });
  const down = await chatDown({});
  assert.equal(down.status, 504);
  assert.equal((await chatDown({})).status, 504, "the slot was released after a failure");
});

test("the gateway refuses to start without a strong token or a model", () => {
  assert.throws(() => createGateway({ token: "short", model: "m" }), /32\+ character/u);
  assert.throws(() => createGateway({ token, models: " , " }), /A model/u);
  assert.throws(() => createGateway({ token, model: "m", concurrency: 0 }), /concurrency/u);
});
