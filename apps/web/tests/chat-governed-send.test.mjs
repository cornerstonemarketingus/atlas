import assert from "node:assert/strict";
import test from "node:test";

import { MAX_GOVERNOR_WAIT_MS, callModel, converse, governedSend } from "../app/api/chat/agent-loop.mjs";
import { chatGovernor, chatGovernorFor } from "../app/api/inference/governor-client.mjs";
import { emptyLedgerState, releaseReservation, reserveCapacity, withdrawRequest } from "../../../packages/atlas-inference/src/index.mjs";

const turns = [{ role: "system", content: "sys" }, { role: "user", content: "hi" }];
const ok = (headers = {}) => new Response(JSON.stringify({ choices: [{ message: { content: "hello" }, finish_reason: "stop" }] }), { headers: { "content-type": "application/json", ...headers } });

/**
 * A governor over a real in-memory ledger, with a controllable clock,
 * recording every call as it would cross the wire (JSON), so a test sees
 * exactly what would leave the Worker.
 */
function ledgerGovernor({ now = () => 0 } = {}) {
  const state = emptyLedgerState();
  const calls = [];
  const wire = (method, argument, apply) => {
    const sent = JSON.parse(JSON.stringify(argument));
    calls.push({ method, argument: sent });
    return apply(sent);
  };
  return {
    state, calls, latencyClass: "INTERACTIVE",
    reserve: async (request) => wire("reserve", request, (sent) => reserveCapacity(state, sent, now())),
    release: async (outcome) => wire("release", outcome, (sent) => releaseReservation(state, { ...sent, headers: sent.headers ? new Headers(sent.headers) : undefined }, now())),
    withdraw: async (requestId) => wire("withdraw", { requestId }, (sent) => { withdrawRequest(state, sent.requestId); return { ok: true }; }),
  };
}

test("without a governor the model call is sent exactly as before", async () => {
  let sent = 0;
  const response = await governedSend({ baseUrl: "https://model.test/v1", model: "m" }, turns, { stream: false, fetcher: async () => { sent += 1; return ok(); } });
  assert.equal(sent, 1);
  assert.equal(response.status, 200);
});

test("a call reserves before sending and releases with only the capacity headers", async () => {
  const governor = ledgerGovernor();
  const order = [];
  const fetcher = async () => {
    order.push("send");
    assert.equal(Object.keys(governor.state.reservations).length, 1, "capacity is held while the call is in flight");
    return ok({ "x-ratelimit-remaining-tokens": "5000", "x-ratelimit-limit-tokens": "6000", "x-request-id": "req-secretish", "set-cookie": "a=b" });
  };
  await governedSend({ baseUrl: "https://model.test/v1", apiKey: "sk-test", model: "m", governor }, turns, { stream: false, fetcher, maxTokens: 100 });
  assert.deepEqual(governor.calls.map((call) => call.method), ["reserve", "release"]);
  const [reserve, release] = governor.calls.map((call) => call.argument);
  assert.deepEqual(reserve.models, ["m"]);
  assert.equal(reserve.latencyClass, "INTERACTIVE");
  assert.ok(reserve.estimatedTokens > 100, "the estimate counts the prompt and the requested output");
  assert.equal(release.requestId, reserve.requestId);
  assert.equal(release.status, 200);
  assert.equal(release.kind, null);
  assert.deepEqual(release.headers, { "x-ratelimit-limit-tokens": "6000", "x-ratelimit-remaining-tokens": "5000" });
  const wire = JSON.stringify(governor.calls);
  for (const secret of ["sk-test", '"content"', "req-secretish", "a=b"]) assert.ok(!wire.includes(secret), `${secret} never reaches the ledger`);
  assert.equal(governor.state.models.m.remainingTokens, 5000, "the provider's own count replaces the estimate");
  assert.equal(Object.keys(governor.state.reservations).length, 0);
});

test("a 429 is released as a rate limit, and the retry waits in the ledger instead of resending at once", async () => {
  let clock = 0;
  const governor = ledgerGovernor({ now: () => clock });
  const slept = [];
  const replies = [
    () => new Response("Rate limit reached. Please try again in 3s.", { status: 429, headers: { "retry-after": "3" } }),
    () => ok(),
  ];
  const response = await callModel({ baseUrl: "https://model.test/v1", model: "m", governor }, turns, {
    stream: false, fetcher: async () => replies.shift()(), sleep: async (ms) => { slept.push(ms); clock += ms; },
  });
  assert.equal(response.status, 200);
  const releases = governor.calls.filter((call) => call.method === "release").map((call) => call.argument);
  assert.equal(releases[0].status, 429);
  assert.equal(releases[0].kind, "RATE_LIMIT");
  assert.equal(releases[0].retryAfterMs, 3000);
  assert.equal(releases[0].scope, "minute");
  assert.equal(releases[1].kind, null);
  assert.deepEqual(slept, [3000], "callModel's own wait covers the block; the ledger adds none");
});

test("while the ledger says capacity returns soon, the call waits for it", async () => {
  let clock = 0;
  const governor = ledgerGovernor({ now: () => clock });
  governor.state.models.m = { limitRequests: null, limitTokens: 6000, remainingRequests: null, remainingTokens: 0, resetRequestsAt: null, resetTokensAt: 2_500, blockedUntil: null, blockedReason: null, observedAt: 0 };
  const slept = [];
  let sent = 0;
  await governedSend({ baseUrl: "https://model.test/v1", model: "m", governor }, turns, {
    stream: false, maxTokens: 10, fetcher: async () => { sent += 1; return ok(); }, sleep: async (ms) => { slept.push(ms); clock += ms; },
  });
  assert.deepEqual(slept, [2500]);
  assert.equal(sent, 1);
  assert.deepEqual(governor.calls.map((call) => call.method), ["reserve", "reserve", "release"]);
});

test("a long capacity wait withdraws without sending to an exhausted model", async () => {
  const governor = ledgerGovernor();
  governor.state.models.m = { limitRequests: null, limitTokens: 6000, remainingRequests: null, remainingTokens: 0, resetRequestsAt: null, resetTokensAt: MAX_GOVERNOR_WAIT_MS + 60_000, blockedUntil: null, blockedReason: null, observedAt: 0 };
  const slept = [];
  let sent = 0;
  const warn = console.warn;
  const logged = [];
  console.warn = (line) => logged.push(line);
  try {
    const response = await governedSend({ baseUrl: "https://model.test/v1", model: "m", governor }, turns, {
      stream: false, maxTokens: 10, fetcher: async () => { sent += 1; return ok(); }, sleep: async (ms) => slept.push(ms),
    });
    assert.equal(response.status, 429);
    assert.equal(response.headers.get("retry-after"), "68");
  } finally {
    console.warn = warn;
  }
  assert.deepEqual(slept, []);
  assert.equal(sent, 0);
  assert.deepEqual(governor.calls.map((call) => call.method), ["reserve", "withdraw"]);
  assert.equal(Object.keys(governor.state.waiting).length, 0, "no stale waiter holds capacity back from others");
  assert.match(logged.join("\n"), /inference\.governor_wait_exceeded/u);
});

test("an unavailable governor (null answers) changes nothing", async () => {
  const governor = { latencyClass: "INTERACTIVE", reserve: async () => null, release: async () => null, withdraw: async () => null };
  let sent = 0;
  const response = await governedSend({ baseUrl: "https://model.test/v1", model: "m", governor }, turns, { stream: false, fetcher: async () => { sent += 1; return ok(); } });
  assert.equal(sent, 1);
  assert.equal(response.status, 200);
});

test("a call that throws still releases its reservation, classified, and the error propagates", async () => {
  const governor = ledgerGovernor();
  const timeout = Object.assign(new Error("timed out"), { name: "TimeoutError" });
  await assert.rejects(governedSend({ baseUrl: "https://model.test/v1", model: "m", governor }, turns, { stream: false, fetcher: async () => { throw timeout; } }), timeout);
  const release = governor.calls.find((call) => call.method === "release").argument;
  assert.equal(release.kind, "TIMEOUT");
  assert.equal(Object.keys(governor.state.reservations).length, 0);
});

test("the fallback model reserves on its own ledger entry", async () => {
  const governor = ledgerGovernor();
  const replies = [
    () => new Response("limit", { status: 429, headers: { "retry-after": "600" } }),
    () => ok(),
  ];
  await callModel({ baseUrl: "https://model.test/v1", model: "m", fallbackModel: "f", governor }, turns, { stream: false, fetcher: async () => replies.shift()(), sleep: async () => {} });
  const reserved = governor.calls.filter((call) => call.method === "reserve").map((call) => call.argument.models[0]);
  assert.deepEqual(reserved, ["m", "f"]);
  assert.ok(governor.state.models.m.blockedUntil >= 600_000, "the refused model stays blocked for what the provider asked");
});

test("a whole chat turn goes through the ledger", async () => {
  const governor = ledgerGovernor();
  const outcome = await converse({
    endpoint: { baseUrl: "https://model.test/v1", model: "m", governor }, turns,
    toolContext: { environment: {}, allowlist: new Set(), githubToken: async () => undefined },
    userMessage: "hi", stream: false, emit: () => {}, fetcher: async () => ok(), tools: [],
  });
  assert.equal(outcome.reply, "hello");
  assert.ok(governor.calls.some((call) => call.method === "reserve"));
  assert.equal(Object.keys(governor.state.reservations).length, 0, "nothing is left reserved after the turn");
});

test("chatGovernorFor is null when there is no binding, and never throws", async () => {
  assert.equal(await chatGovernorFor({ baseUrl: "https://model.test/v1", apiKey: "k" }, {}), null);
  const warn = console.warn;
  console.warn = () => {};
  try {
    assert.equal(await chatGovernorFor({ baseUrl: "not a url" }, { INFERENCE_GOVERNOR: { idFromName: () => "id", get: () => ({}) } }), null);
  } finally {
    console.warn = warn;
  }
  assert.equal(chatGovernor(null), null);
  const bound = await chatGovernorFor({ baseUrl: "https://model.test/v1", apiKey: "k" }, { INFERENCE_GOVERNOR: { idFromName: (name) => name, get: () => ({ fetch: async () => Response.json({ granted: true, model: "m" }) }) } });
  assert.deepEqual(await bound.reserve({ requestId: "r", models: ["m"], estimatedTokens: 1 }), { granted: true, model: "m" });
});

const blockedEntry = (until) => ({ limitRequests: null, limitTokens: 6000, remainingRequests: null, remainingTokens: 0, resetRequestsAt: null, resetTokensAt: until, blockedUntil: null, blockedReason: null, observedAt: 0 });

test("with a pool, a call goes to the first model that has capacity, and the reply is attributed to it", async () => {
  const governor = ledgerGovernor();
  governor.state.models.main = blockedEntry(60_000);
  const sentTo = [];
  const response = await callModel({ baseUrl: "https://model.test/v1", model: "main", models: ["main", "spare", "f"], fallbackModel: "f", governor }, turns, {
    stream: false, maxTokens: 10, fetcher: async (_url, init) => { sentTo.push(JSON.parse(init.body).model); return ok(); }, sleep: async () => assert.fail("no wait while another model has room"),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(sentTo, ["spare"]);
  const release = governor.calls.find((call) => call.method === "release").argument;
  assert.equal(release.model, "spare", "the ledger is told which model actually served");
  assert.deepEqual(governor.calls[0].argument.models, ["main", "spare", "f"]);
});

test("with a pool, a 429 routes the retry to another model at once instead of sleeping", async () => {
  let clock = 0;
  const governor = ledgerGovernor({ now: () => clock });
  const sentTo = [];
  const replies = [
    () => new Response("Rate limit reached. Please try again in 6s.", { status: 429, headers: { "retry-after": "6" } }),
    () => ok(),
  ];
  const slept = [];
  await callModel({ baseUrl: "https://model.test/v1", model: "main", models: ["main", "spare"], governor }, turns, {
    stream: false, maxTokens: 10, fetcher: async (_url, init) => { sentTo.push(JSON.parse(init.body).model); return replies.shift()(); }, sleep: async (ms) => { slept.push(ms); clock += ms; },
  });
  assert.deepEqual(sentTo, ["main", "spare"]);
  assert.deepEqual(slept, [], "the refused model is blocked in the ledger; nobody waits for it");
});

test("without a governor, a pool changes nothing: same wait-and-retry as before", async () => {
  const sentTo = [];
  const slept = [];
  const replies = [() => new Response("", { status: 429, headers: { "retry-after": "2" } }), () => ok()];
  await callModel({ baseUrl: "https://model.test/v1", model: "main", models: ["main", "spare"] }, turns, {
    stream: false, fetcher: async (_url, init) => { sentTo.push(JSON.parse(init.body).model); return replies.shift()(); }, sleep: async (ms) => slept.push(ms),
  });
  assert.deepEqual(sentTo, ["main", "main"]);
  assert.deepEqual(slept, [2000]);
});

test("latency classes: the lead is INTERACTIVE, child agents are TASK_CRITICAL, and synthesis goes first in its class", async () => {
  const governor = ledgerGovernor();
  const empty = () => new Response(JSON.stringify({ choices: [{ message: { content: "" }, finish_reason: "stop" }] }), { headers: { "content-type": "application/json" } });
  const replies = [empty, ok];
  await converse({
    endpoint: { baseUrl: "https://model.test/v1", model: "m", governor }, turns,
    toolContext: { environment: {}, allowlist: new Set(), githubToken: async () => undefined },
    userMessage: "hi", stream: false, emit: () => {}, fetcher: async () => replies.shift()(), tools: [], sleep: async () => {},
  });
  const reserves = governor.calls.filter((call) => call.method === "reserve").map((call) => call.argument);
  assert.deepEqual(reserves.map((request) => [request.latencyClass, request.priority]), [["INTERACTIVE", 0], ["INTERACTIVE", 10]], "the empty reply is finished by a synthesis call that outranks ordinary steps");

  const child = ledgerGovernor();
  await converse({
    endpoint: { baseUrl: "https://model.test/v1", model: "m", governor: child }, turns, agentId: "a1",
    toolContext: { environment: {}, allowlist: new Set(), githubToken: async () => undefined },
    userMessage: "hi", stream: false, emit: () => {}, fetcher: async () => ok(), tools: [], allowTasks: false,
  });
  assert.equal(child.calls.find((call) => call.method === "reserve").argument.latencyClass, "TASK_CRITICAL");
});

test("the agent-team planner reserves as TASK_CRITICAL", async () => {
  const { plannerClient } = await import("../app/api/chat/agent-team.mjs");
  const governor = ledgerGovernor();
  const client = plannerClient({ baseUrl: "https://model.test/v1", model: "m", governor }, async () => ok());
  const chunks = [];
  for await (const chunk of client.stream({ messages: turns, maxOutputTokens: 10 })) chunks.push(chunk.type);
  assert.deepEqual(chunks, ["text", "done"]);
  assert.equal(governor.calls.find((call) => call.method === "reserve").argument.latencyClass, "TASK_CRITICAL");
});

test("diagnostics name the pool model that actually answered", async () => {
  const governor = ledgerGovernor();
  governor.state.models.main = blockedEntry(60_000);
  const empty = () => new Response(JSON.stringify({ choices: [{ message: { content: "" }, finish_reason: "stop" }] }), { headers: { "content-type": "application/json" } });
  const replies = [empty, ok];
  const logged = [];
  const warn = console.warn;
  console.warn = (line) => logged.push(line);
  try {
    await converse({
      endpoint: { baseUrl: "https://model.test/v1", model: "main", models: ["main", "spare"], governor }, turns,
      toolContext: { environment: {}, allowlist: new Set(), githubToken: async () => undefined },
      userMessage: "hi", stream: false, emit: () => {}, fetcher: async () => replies.shift()(), tools: [], sleep: async () => {},
    });
  } finally {
    console.warn = warn;
  }
  const records = logged.map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
  const empties = records.filter((record) => record.event === "inference.empty_response");
  assert.ok(empties.length > 0, "the empty reply is reported");
  assert.equal(empties[0].model, "spare");
  assert.equal(empties[0].fallbackUsed, true);
});

test("with a pool but a governor that does not answer, a 429 still gets the short wait before the retry", async () => {
  const governor = { latencyClass: "INTERACTIVE", reserve: async () => null, release: async () => null, withdraw: async () => null };
  const slept = [];
  const replies = [() => new Response("", { status: 429, headers: { "retry-after": "2" } }), () => ok()];
  await callModel({ baseUrl: "https://model.test/v1", model: "main", models: ["main", "spare"], governor }, turns, {
    stream: false, fetcher: async () => replies.shift()(), sleep: async (ms) => slept.push(ms),
  });
  assert.deepEqual(slept, [2000], "without the ledger's record, retrying at once would only be refused again");
});

test("known exhausted primary routes to fallback without a refused provider request", async () => {
  const governor = ledgerGovernor();
  governor.state.models.m = { limitRequests: null, limitTokens: 6000, remainingRequests: null, remainingTokens: 0, resetRequestsAt: null, resetTokensAt: 60_000, blockedUntil: null, blockedReason: null, observedAt: 0 };
  const sent = [];
  const response = await callModel({ baseUrl: "https://model.test/v1", model: "m", fallbackModel: "f", governor }, turns, {
    stream: false, fetcher: async (_url, init) => { sent.push(JSON.parse(init.body).model); return ok(); }, sleep: async () => assert.fail("no inline wait for daily/exhausted primary"),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(sent, ["f"]);
  assert.equal(Object.keys(governor.state.reservations).length, 0);
  assert.equal(Object.keys(governor.state.waiting).length, 0);
});

test("persistent zero-delay denials remain bounded and never bypass admission", async () => {
  let attempts = 0;
  let withdrawn = 0;
  const governor = { reserve: async () => { attempts++; return { granted: false, waitMs: 0 }; }, withdraw: async () => { withdrawn++; } };
  const response = await governedSend({ baseUrl: "https://model.test/v1", model: "m", governor }, turns, {
    stream: false, fetcher: async () => assert.fail("denied request sent"), sleep: async () => {},
  });
  assert.equal(response.status, 429);
  assert.equal(attempts, 9);
  assert.equal(withdrawn, 1);
});

test("streaming holds capacity until generation finishes and releases on cancellation", async () => {
  for (const cancel of [false, true]) {
    const governor = ledgerGovernor();
    const response = await governedSend({ baseUrl: "https://model.test/v1", model: "m", governor }, turns, {
      stream: true, fetcher: async () => new Response(new ReadableStream({ pull(controller) { controller.enqueue(new TextEncoder().encode("data: hello\n\n")); if (!cancel) controller.close(); } }), { headers: { "content-type": "text/event-stream" } }),
    });
    assert.equal(Object.keys(governor.state.reservations).length, 1);
    if (cancel) await response.body.cancel();
    else await response.text();
    assert.equal(Object.keys(governor.state.reservations).length, 0);
    assert.equal(governor.calls.filter(call => call.method === "release").length, 1);
  }
});

test("stream read failure releases the reservation exactly once", async () => {
  const governor = ledgerGovernor();
  const response = await governedSend({ baseUrl: "https://model.test/v1", model: "m", governor }, turns, {
    stream: true, fetcher: async () => new Response(new ReadableStream({ pull(controller) { controller.error(new TypeError("stream disconnected")); } }), { headers: { "content-type": "text/event-stream" } }),
  });
  await assert.rejects(response.text(), /stream disconnected/u);
  assert.equal(Object.keys(governor.state.reservations).length, 0);
  assert.equal(governor.calls.filter(call => call.method === "release").length, 1);
});

test("a streamed reply from a pool model keeps its attribution through the held reservation", async () => {
  const governor = ledgerGovernor();
  governor.state.models.main = blockedEntry(60_000);
  // An empty streamed reply, so the loop reports which model gave it; then the synthesis answers.
  const replies = [() => new Response('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } }), ok];
  const logged = [];
  const warn = console.warn;
  console.warn = (line) => logged.push(line);
  try {
    await converse({
      endpoint: { baseUrl: "https://model.test/v1", model: "main", models: ["main", "spare"], governor }, turns,
      toolContext: { environment: {}, allowlist: new Set(), githubToken: async () => undefined },
      userMessage: "hi", stream: true, emit: () => {}, fetcher: async () => replies.shift()(), tools: [], sleep: async () => {},
    });
  } finally {
    console.warn = warn;
  }
  const empty = logged.map((line) => { try { return JSON.parse(line); } catch { return null; } }).find((record) => record?.event === "inference.empty_response");
  assert.equal(empty?.model, "spare", "the wrapped stream still names the model that answered");
  assert.equal(governor.calls.find((call) => call.method === "release").argument.model, "spare");
  assert.equal(Object.keys(governor.state.reservations).length, 0, "released once the stream was read to the end");
});
