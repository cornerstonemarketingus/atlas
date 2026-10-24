import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { chatEventStream, createEventParser, KEEP_ALIVE_MS } from "../app/api/chat/stream.mjs";
import { readWithIdleTimeout, STREAM_IDLE_MS, StreamIdleError } from "../app/chat/stream-idle.mjs";

async function readAll(stream) {
  const reader = stream.getReader(); const decoder = new TextDecoder(); let text = "";
  for (;;) { const { value, done } = await reader.read(); if (done) return text; text += decoder.decode(value, { stream: true }); }
}

test("a turn that throws still ends the stream with an error event, never silently", { timeout: 5000 }, async () => {
  let reported = null;
  const text = await readAll(chatEventStream(async (emit) => {
    emit("meta", { conversationId: "c" });
    emit("tool", { id: "t", label: "x", state: "running" });
    throw new Error("PRIVATE provider detail");
  }, { onError: (error) => { reported = error.message; } }));
  const events = createEventParser().push(text);
  assert.deepEqual(events.map((event) => event.type), ["meta", "tool", "error"]);
  assert.doesNotMatch(text, /PRIVATE/u, "the browser sees the fixed customer message only");
  assert.equal(reported, "PRIVATE provider detail");
});

test("a slow turn sends keep-alive comments that the browser parser ignores, then its answer", { timeout: 5000 }, async () => {
  const text = await readAll(chatEventStream(async (emit) => {
    await new Promise((resolve) => setTimeout(resolve, 70));
    emit("done", { conversationId: "c", stored: true, reply: { id: "r", role: "assistant", content: "Answer", createdAt: "t" } });
  }, { keepAliveMs: 20 }));
  assert.ok((text.match(/: keep-alive/gu) ?? []).length >= 2);
  const events = createEventParser().push(text).filter((event) => event.data !== null);
  assert.deepEqual(events.map((event) => event.type), ["done"]);
});

test("cancelling the response stops the keep-alive timer and later emits are dropped", { timeout: 5000 }, async () => {
  let finish;
  const stream = chatEventStream((emit) => new Promise((resolve) => { finish = () => { emit("done", { reply: null }); resolve(); }; }), { keepAliveMs: 10 });
  const reader = stream.getReader();
  await reader.cancel();
  finish();
  await new Promise((resolve) => setTimeout(resolve, 30));
});

test("the browser waits far longer than the keep-alive interval before calling a stream dead", async () => {
  assert.ok(STREAM_IDLE_MS >= KEEP_ALIVE_MS * 3);
  const silent = new ReadableStream({ start() {} }).getReader();
  await assert.rejects(readWithIdleTimeout(silent, 20), StreamIdleError);
  const live = new ReadableStream({ start(controller) { controller.enqueue(1); } }).getReader();
  assert.deepEqual(await readWithIdleTimeout(live, 1000), { value: 1, done: false });
});

test("the chat route streams through the guarded event stream", () => {
  const source = readFileSync(new URL("../app/api/chat/route.ts", import.meta.url), "utf8");
  assert.match(source, /chatEventStream\(async \(emit\)/u);
  assert.doesNotMatch(source, /new ReadableStream/u);
});
