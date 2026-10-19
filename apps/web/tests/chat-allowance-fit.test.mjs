import assert from "node:assert/strict";
import test from "node:test";

import { MIN_FITTED_REPLY_TOKENS, callModel, fitToAllowance, governedSend, statedLimitTokens } from "../app/api/chat/agent-loop.mjs";
import { emptyLedgerState, estimateRequestTokens, observeLedger, releaseReservation, reserveCapacity, withdrawRequest } from "../../../packages/atlas-inference/src/index.mjs";

// A free Groq tier refuses any request whose prompt plus max_tokens is over
// its tokens-per-minute allowance (8,000 for gpt-oss). Atlas fits the request
// to the allowance instead of failing the reply.

const ok = () => new Response(JSON.stringify({ choices: [{ message: { content: "hello" }, finish_reason: "stop" }] }), { headers: { "content-type": "application/json" } });
const system = { role: "system", content: "s".repeat(9_000) };
const latest = { role: "user", content: "Find the most likely bug in my project and fix it." };
const tokens = (messages) => estimateRequestTokens({ messages });

test("a smaller reply budget is the first and only change when it is enough", () => {
  const turns = [system, latest];
  const fit = fitToAllowance(turns, { maxTokens: 2_048 }, tokens(turns) + 1_500);
  assert.equal(fit.turns, turns);
  assert.equal(fit.maxTokens, 1_500 - 256);
});

test("then the oldest earlier turns go; the system prompt, latest message and work since it stay", () => {
  const history = Array.from({ length: 6 }, (_, index) => ({ role: index % 2 ? "assistant" : "user", content: `turn ${index} ${"h".repeat(3_000)}` }));
  const work = [{ role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "web_search", arguments: "{}" } }] }, { role: "tool", tool_call_id: "c1", content: "result" }];
  const turns = [system, ...history, latest, ...work];
  const limit = tokens([system, ...history.slice(4), latest, ...work]) + 256 + MIN_FITTED_REPLY_TOKENS;
  const fit = fitToAllowance(turns, { maxTokens: 2_048 }, limit);
  assert.ok(fit);
  assert.equal(fit.turns[0], system);
  assert.deepEqual(fit.turns.slice(-3), [latest, ...work]);
  assert.ok(fit.turns.length < turns.length && fit.turns.length >= 4, "only as much history as needed is dropped");
  assert.ok(!fit.turns.some((turn) => turn.content?.startsWith("turn 0")), "the oldest goes first");
  assert.ok(fit.maxTokens >= MIN_FITTED_REPLY_TOKENS);
});

test("nothing fits when the system prompt and latest message alone are over the allowance", () => {
  assert.equal(fitToAllowance([system, latest], { maxTokens: 2_048 }, 1_000), null);
});

test("the provider's stated limit is scaled to the estimator by how it counted this request", () => {
  const turns = [system, latest];
  const estimated = tokens(turns);
  const body = JSON.stringify({ error: { message: `Request too large for model on tokens per minute (TPM): Limit 8000, Requested ${estimated / 2 + 2_048}` } });
  assert.equal(statedLimitTokens(body, turns, { maxTokens: 2_048 }), 16_000);
  assert.equal(statedLimitTokens("Request too large on tokens per minute (TPM)", turns, {}), null);
});

test("a ledger refusal for a request over every model's allowance is refitted and sent, not given up", async () => {
  const state = emptyLedgerState();
  observeLedger(state, "openai/gpt-oss-120b", new Headers({ "x-ratelimit-limit-tokens": "8000", "x-ratelimit-remaining-tokens": "8000" }), 0);
  const governor = {
    latencyClass: "INTERACTIVE",
    reserve: async (request) => reserveCapacity(state, request, 0),
    release: async (outcome) => releaseReservation(state, outcome, 0),
    withdraw: async (requestId) => withdrawRequest(state, requestId),
  };
  const turns = [{ role: "system", content: "s".repeat(18_000) }, latest];
  const sent = [];
  const response = await governedSend({ baseUrl: "https://api.groq.com/openai/v1/", model: "openai/gpt-oss-120b", governor }, turns,
    { stream: false, maxTokens: 2_048, fetcher: async (_url, init) => { sent.push(JSON.parse(init.body)); return ok(); } });
  assert.equal(response.status, 200);
  assert.equal(sent.length, 1);
  assert.ok(sent[0].max_tokens < 2_048 && sent[0].max_tokens >= MIN_FITTED_REPLY_TOKENS, `reply budget ${sent[0].max_tokens}`);
  assert.ok(estimateRequestTokens({ messages: sent[0].messages }) + sent[0].max_tokens <= 8_000);
});

test("a provider refusal that states its allowance is refitted once and answered", async () => {
  const history = Array.from({ length: 8 }, (_, index) => ({ role: index % 2 ? "assistant" : "user", content: "h".repeat(4_000) }));
  const turns = [system, ...history, latest];
  const sent = [];
  let status = 413;
  const fetcher = async (_url, init) => {
    const body = JSON.parse(init.body);
    sent.push(body);
    // Count as the estimator does, so the stated numbers are consistent with what was sent.
    const requested = estimateRequestTokens({ messages: body.messages, tools: body.tools }) + body.max_tokens;
    return requested > 8_000
      ? new Response(JSON.stringify({ error: { message: `Request too large for model \`openai/gpt-oss-120b\` on tokens per minute (TPM): Limit 8000, Requested ${requested}`, code: "rate_limit_exceeded" } }), { status })
      : ok();
  };
  for (status of [413, 429]) {
    sent.length = 0;
    const response = await callModel({ baseUrl: "https://api.groq.com/openai/v1/", model: "openai/gpt-oss-120b", fallbackModel: null }, turns, { stream: false, fetcher, maxTokens: 2_048, trail: [] });
    assert.equal(response.status, 200, `status ${status}`);
    assert.equal(sent.length, 2);
    assert.equal(sent[1].messages[0].content, system.content);
    assert.equal(sent[1].messages.at(-1).content, latest.content);
  }
});
