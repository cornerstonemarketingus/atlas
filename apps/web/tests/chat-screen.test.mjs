import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";
import { createEventParser } from "../app/api/chat/stream.mjs";
import { classifyIntent } from "../app/chat/intent.mjs";
import { createScrollFollow } from "../app/chat/scroll-follow.mjs";
import { latestProjectReceipt } from "../app/chat/project-receipts.mjs";
let streamIdle = null;
try { streamIdle = await import("../app/chat/stream-idle.mjs"); } catch { /* reproduction run before the fix */ }

// Execute the real component with a small hook host. Requests remain deferred
// so navigation and typing can happen before an earlier response completes.
function screen(repository = "", { idleMs = 40 } = {}) {
  const slots = [];
  let cursor = 0;
  const requests = [];
  const react = {
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === "function" ? initial() : initial;
      return [slots[index], (value) => { slots[index] = typeof value === "function" ? value(slots[index]) : value; }];
    },
    useRef(initial) {
      const index = cursor++;
      return slots[index] ??= { current: initial };
    },
    useEffect() {},
    useCallback(callback) { return callback; },
  };
  const output = ts.transpileModule(readFileSync(new URL("../app/chat/ChatSection.tsx", import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const exports = {};
  const context = vm.createContext({
    exports, Date, Map, Error, console, AbortController, DOMException, TextDecoder, setTimeout, clearTimeout,
    window: { localStorage: { getItem: () => repository } },
    fetch: (url, options) => new Promise((resolve, reject) => requests.push({ url, options, resolve, reject })),
    require(name) {
      if (name.includes("project-receipts.mjs")) return { latestProjectReceipt };
      if (name.includes("stream-idle.mjs")) return { ...streamIdle, STREAM_IDLE_MS: idleMs };
      if (name === "react") return react;
      if (name.includes("scroll-follow.mjs")) return { createScrollFollow };
      if (name.includes("intent.mjs")) return { classifyIntent };
      if (name.includes("stream.mjs")) return { createEventParser };
      if (name === "react/jsx-runtime") return { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) };
      if (name.includes("ThreadRail")) return { ThreadRail: "rail", useThreads: () => ({ threads: [], close: async () => true }) };
      if (name.includes("ProjectSwitcher")) return { PROJECT_STORAGE_KEY: "project" };
      return new Proxy({}, { get: (_, key) => key });
    },
  });
  vm.runInContext(output, context);
  const render = () => { cursor = 0; return exports.ChatSection(); };
  const find = (node, type) => {
    if (!node || typeof node !== "object") return undefined;
    if (node.type === type) return node;
    return [node.props?.children].flat(Infinity).map((child) => find(child, type)).find(Boolean);
  };
  return {
    requests, render,
    draft: () => find(render(), "textarea").props.value,
    type: (value) => find(render(), "textarea").props.onChange({ target: { value } }),
    send: () => find(render(), "form").props.onSubmit({ preventDefault() {} }),
  };
}

test("failed sends restore the draft and preserve text typed during the request", async () => {
  const chat = screen();
  chat.type("Original question");
  const first = chat.send();
  chat.requests[0].resolve(Response.json({ message: "Unavailable" }, { status: 503 }));
  await first;
  assert.equal(chat.draft(), "Original question");
  const second = chat.send();
  chat.type("Next question");
  chat.requests[1].reject(new Error("Offline"));
  await second;
  assert.equal(chat.draft(), "Next question");
});

test("a completed send cannot reopen a conversation after New chat", async () => {
  const chat = screen();
  chat.type("Hello");
  const pending = chat.send();
  chat.render().props.rail.props.onNew();
  chat.type("New draft");
  chat.requests[0].resolve(Response.json({ conversationId: "old-thread", reply: { id: "reply", role: "assistant", content: "Old reply" } }));
  await pending;
  assert.equal(chat.render().props.rail.props.activeId, null);
  assert.equal(chat.draft(), "New draft");
  assert.equal(JSON.stringify(chat.render()).includes("Old reply"), false);
});

test("out-of-order history responses cannot replace the selected thread", async () => {
  const chat = screen();
  const first = chat.render().props.rail.props.onOpen("first");
  const second = chat.render().props.rail.props.onOpen("second");
  chat.requests[1].resolve(Response.json({ messages: [{ id: "b", role: "assistant", content: "Second reply" }] }));
  await second;
  chat.requests[0].resolve(Response.json({ messages: [{ id: "a", role: "assistant", content: "First reply" }] }));
  await first;
  // onOpen intentionally returns void; flush the response parsing microtasks.
  await new Promise((resolve) => setImmediate(resolve));
  const view = chat.render();
  assert.equal(view.props.rail.props.activeId, "second");
  assert.equal(JSON.stringify(view).includes("Second reply"), true);
  assert.equal(JSON.stringify(view).includes("First reply"), false);
});

test("late SSE events cannot update a new chat even if transport ignores abort", async () => {
  const chat = screen();
  chat.type("Hello");
  const pending = chat.send();
  let stream;
  chat.requests[0].resolve(new Response(new ReadableStream({ start(controller) { stream = controller; } }), { headers: { "content-type": "text/event-stream" } }));
  await new Promise((resolve) => setImmediate(resolve));
  chat.render().props.rail.props.onNew();
  chat.type("New draft");
  stream.enqueue(new TextEncoder().encode('event: meta\ndata: {"conversationId":"old-thread"}\n\nevent: done\ndata: {"reply":{"id":"old","role":"assistant","content":"Late reply"}}\n\n'));
  await pending;
  assert.equal(chat.render().props.rail.props.activeId, null);
  assert.equal(chat.draft(), "New draft");
  assert.equal(JSON.stringify(chat.render()).includes("Late reply"), false);
});

test("a truncated reply restores the draft and a completed reply does not", async () => {
  const chat = screen();
  chat.type("Question");
  const failed = chat.send();
  chat.requests[0].resolve(new Response('event: delta\ndata: {"text":"partial"}\n\n', { headers: { "content-type": "text/event-stream" } }));
  await failed;
  assert.equal(chat.draft(), "Question");
  const retried = chat.send();
  chat.requests[1].resolve(new Response('event: done\ndata: {"stored":false,"reply":{"id":"reply","role":"assistant","content":"Complete"}}\n\n', { headers: { "content-type": "text/event-stream" } }));
  await retried;
  assert.equal(chat.draft(), "");
  assert.equal(JSON.stringify(chat.render()).includes("Complete"), true);
});

test("hitting the daily cap shows the local model first, then plans, keeps the draft, and clears on the next send", async () => {
  const chat = screen();
  chat.type("One more question");
  const first = chat.send();
  chat.requests[0].resolve(Response.json({ message: "You have used today's 20 free messages.", code: "CHAT_CAP_REACHED" }, { status: 429 }));
  await first;
  const shown = JSON.stringify(chat.render());
  assert.match(shown, /You have used today's 20 free messages/u);
  assert.ok(shown.indexOf("/guide#local-model") > -1 && shown.indexOf("/guide#local-model") < shown.indexOf("/pricing"), "local model is offered before a plan");
  assert.equal(chat.draft(), "One more question", "the unsent message is not lost");
  const second = chat.send();
  assert.doesNotMatch(JSON.stringify(chat.render()), /cap-options/u, "the options clear when the user tries again");
  chat.requests[1].resolve(Response.json({ message: "Unavailable" }, { status: 503 }));
  await second;
  assert.doesNotMatch(JSON.stringify(chat.render()), /cap-options/u, "an unrelated failure does not show the cap options");
});

test("a 200 stream that goes silent after a step ends with a clear error and the draft ready to retry", { timeout: 5000 }, async () => {
  // Reproduces the hosted hang: HTTP 200, a meta and one tool step, then no
  // further bytes and no close. The UI must not stay on "1 step" forever.
  const chat = screen();
  chat.type("Build me a site");
  const pending = chat.send();
  chat.requests[0].resolve(new Response(new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode('event: meta\ndata: {"conversationId":"c"}\n\nevent: tool\ndata: {"id":"t1","label":"Working on your request","state":"running"}\n\n'));
  } }), { headers: { "content-type": "text/event-stream" } }));
  const outcome = await Promise.race([pending.then(() => "settled"), new Promise((resolve) => setTimeout(() => resolve("hung"), 1500))]);
  assert.equal(outcome, "settled", "the send must settle once the stream goes silent");
  const view = JSON.stringify(chat.render());
  assert.match(view, /stopped responding/u);
  assert.equal(chat.draft(), "Build me a site");
});

test("keep-alive comments hold a slow turn open until its answer arrives", { timeout: 5000 }, async () => {
  const chat = screen("", { idleMs: 60 });
  chat.type("Slow question");
  const pending = chat.send();
  let stream;
  chat.requests[0].resolve(new Response(new ReadableStream({ start(controller) { stream = controller; } }), { headers: { "content-type": "text/event-stream" } }));
  const encode = (text) => new TextEncoder().encode(text);
  for (let beat = 0; beat < 4; beat++) { await new Promise((resolve) => setTimeout(resolve, 30)); stream.enqueue(encode(": keep-alive\n\n")); }
  stream.enqueue(encode('event: done\ndata: {"reply":{"id":"r","role":"assistant","content":"Slow answer"}}\n\n'));
  stream.close();
  await pending;
  assert.match(JSON.stringify(chat.render()), /Slow answer/u);
  assert.equal(chat.draft(), "");
});
