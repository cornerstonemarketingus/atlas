import assert from "node:assert/strict";
import test from "node:test";

import { createSpeechTranscriber } from "../src/agent/speech.mjs";
import {
  VoiceCommandInterface,
  confirmationCode,
  parseIntent,
  progressUpdate,
} from "../src/platform/voice/voice-commands.mjs";

function harness(options = {}) {
  let now = new Date("2026-09-01T12:00:00Z").getTime();
  const clock = () => new Date(now);
  const calls = [];
  const handlers = {
    createTask: async ({ objective }) => { calls.push(["createTask", objective]); return { taskId: "t1" }; },
    status: async ({ target }) => { calls.push(["status", target]); return { task: { objective: "Refresh the invoice report", status: "running", stepsDone: 2, stepsTotal: 5 } }; },
    approve: async (args) => { calls.push(["approve", args]); return {}; },
    cancel: async (args) => { calls.push(["cancel", args]); return {}; },
    emergencyStop: async (args) => { calls.push(["emergencyStop", args]); return {}; },
    resolveTarget: async ({ target }) => (target.includes("unknown") ? null : { id: `id:${target}`, label: target }),
  };
  const voice = new VoiceCommandInterface({ handlers, clock, confirmationTtlMs: 30_000, ...options });
  return { voice, calls, advance: (ms) => { now += ms; } };
}

test("intent parsing", () => {
  assert.equal(parseIntent("Atlas, create a task to summarize the Q3 report.").intent, "create_task");
  assert.equal(parseIntent("create a task to summarize the Q3 report").objective, "summarize the q3 report");
  assert.equal(parseIntent("What's the status of the invoice task?").intent, "status");
  assert.equal(parseIntent("approve the deploy request").intent, "approve");
  assert.equal(parseIntent("Cancel task invoice refresh").target, "invoice refresh");
  assert.equal(parseIntent("EMERGENCY STOP!").intent, "emergency_stop");
  assert.equal(parseIntent("confirm four seven one two").code, "4712");
  assert.equal(parseIntent("confirm 47 12").code, "4712");
  assert.equal(parseIntent("tell me a joke").intent, null);
});

test("non-consequential intents run immediately with speakable output", async () => {
  const { voice, calls } = harness();
  const created = await voice.handleTranscript({ text: "create a task to email the weekly summary", confidence: 0.95 });
  assert.equal(created.action, "executed");
  assert.deepEqual(calls[0], ["createTask", "email the weekly summary"]);
  const status = await voice.handleTranscript({ text: "status of the invoice task", confidence: 0.95 });
  assert.equal(status.speech, "Refresh the invoice report is running, 2 of 5 steps done.");
});

test("low-confidence transcripts cause no action", async () => {
  const { voice, calls } = harness();
  const r = await voice.handleTranscript({ text: "emergency stop", confidence: 0.4 });
  assert.equal(r.action, "ignored");
  assert.equal(r.reason, "low_confidence");
  const c = await voice.handleTranscript({ text: "create a task to buy stock", confidence: 0.5 });
  assert.equal(c.action, "ignored");
  assert.equal(calls.length, 0);
  assert.equal(voice.pending, null);
  // unknown confidence (stock whisper endpoint): read-only only
  assert.equal((await voice.handleTranscript({ text: "status" })).action, "executed");
  assert.equal((await voice.handleTranscript({ text: "create a task to buy stock" })).action, "ignored");
});

test("consequential intents need a spoken confirmation bound to the action digest", async () => {
  const { voice, calls } = harness();
  const ask = await voice.handleTranscript({ text: "cancel the invoice task", confidence: 0.9 });
  assert.equal(ask.action, "awaiting_confirmation");
  assert.equal(calls.length, 0, "nothing runs on the first utterance");
  assert.equal(ask.code, confirmationCode(ask.actionDigest));
  assert.match(ask.speech, new RegExp(`say confirm ${ask.code.split("").join(" ")}`, "u"));

  const wrong = await voice.handleTranscript({ text: `confirm ${ask.code === "0000" ? "1111" : "0000"}`, confidence: 0.95 });
  assert.equal(wrong.reason, "code_mismatch");
  assert.equal(calls.length, 0);

  const ok = await voice.handleTranscript({ text: `confirm ${ask.code.split("").join(" ")}`, confidence: 0.95 });
  assert.equal(ok.action, "executed");
  assert.equal(ok.confirmed, true);
  assert.deepEqual(calls[0], ["cancel", { target: "id:invoice task", objective: undefined, actionDigest: ask.actionDigest }]);

  const replay = await voice.handleTranscript({ text: `confirm ${ask.code}`, confidence: 0.95 });
  assert.equal(replay.reason, "nothing_pending", "a confirmation is single-use");
  assert.equal(calls.length, 1);
});

test("a confirmation for one action cannot confirm another, and expires after the TTL", async () => {
  const { voice, calls, advance } = harness();
  const first = await voice.handleTranscript({ text: "approve the deploy request", confidence: 0.9 });
  const second = await voice.handleTranscript({ text: "emergency stop", confidence: 0.9 });
  assert.notEqual(first.actionDigest, second.actionDigest);
  if (first.code !== second.code) {
    const stale = await voice.handleTranscript({ text: `confirm ${first.code}`, confidence: 0.95 });
    assert.equal(stale.reason, "code_mismatch", "the newer request replaced the older one");
  }
  advance(31_000);
  const late = await voice.handleTranscript({ text: `confirm ${second.code}`, confidence: 0.95 });
  assert.equal(late.reason, "confirmation_expired");
  assert.equal(calls.length, 0);

  const again = await voice.handleTranscript({ text: "emergency stop", confidence: 0.9 });
  const low = await voice.handleTranscript({ text: `confirm ${again.code}`, confidence: 0.3 });
  assert.equal(low.reason, "low_confidence");
  const dismissed = await voice.handleTranscript({ text: "never mind", confidence: 0.9 });
  assert.equal(dismissed.action, "dismissed");
  assert.equal((await voice.handleTranscript({ text: `confirm ${again.code}`, confidence: 0.9 })).reason, "nothing_pending");
  assert.equal(calls.length, 0);
});

test("confirmation must come from the same speaker; unknown targets are refused", async () => {
  const { voice, calls } = harness();
  const ask = await voice.handleTranscript({ text: "cancel the report task", confidence: 0.9, speakerId: "owner" });
  const other = await voice.handleTranscript({ text: `confirm ${ask.code}`, confidence: 0.9, speakerId: "guest" });
  assert.equal(other.reason, "different_speaker");
  const unknown = await voice.handleTranscript({ text: "cancel the unknown thing", confidence: 0.9 });
  assert.equal(unknown.reason, "unknown_target");
  assert.equal(calls.length, 0);
  assert.ok(voice.log.length >= 3);
});

test("hear() goes through the existing speech transcriber", async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ text: "What's the status?" }), { status: 200, headers: { "content-type": "application/json" } });
  const transcriber = createSpeechTranscriber({ baseUrl: "http://127.0.0.1:8080/v1", fetchImpl });
  const { voice, calls } = harness({ transcriber });
  const r = await voice.hear({ audio: Buffer.from("fake"), mediaType: "audio/wav" });
  assert.equal(r.intent, "status");
  assert.equal(r.action, "executed");
  assert.equal(calls[0][0], "status");
});

test("progress updates are short and speakable", () => {
  const text = progressUpdate({
    objective: "Collect **pricing** from https://example.com for tsk_0123456789abcdef0123456789abcdef and then write a very long report about everything",
    status: "waiting_for_approval", stepsDone: 3, stepsTotal: 4, pendingApprovals: 1, costMicroUsd: 1_250_000,
  });
  assert.doesNotMatch(text, /https?:|tsk_|\*/u);
  assert.ok(text.split(" ").length <= 30);
  assert.match(text, /waiting for approval/u);
  assert.match(text, /1 approval waiting for you/u);
  assert.match(text, /1\.25 dollars/u);
  assert.equal(progressUpdate(null), "I could not find that task.");
});
