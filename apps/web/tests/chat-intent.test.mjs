import assert from "node:assert/strict";
import test from "node:test";

import { classifyIntent } from "../app/chat/intent.mjs";
import { createDeltaParser, createEventParser, encodeEvent } from "../app/api/chat/stream.mjs";

const project = { hasProject: true };

test("questions are answered, never dispatched", () => {
  for (const message of [
    "hi can u debug yourself?",
    "Can you explain how to write a good test?",
    "How do I review a pull request well?",
    "What should I build next?",
    "Is it worth adding a cache here?",
    "hello",
    "fix it",
    "Explain the architecture of my project",
  ]) {
    assert.deepEqual(classifyIntent(message, project), { kind: "chat" }, message);
  }
});

test("clear requests for project work are offered as tasks with the right mode", () => {
  assert.equal(classifyIntent("Fix the login bug in my project. Read the code first and open a pull request.", project).mode, "coder");
  assert.equal(classifyIntent("Please add a dark mode toggle to the settings page", project).mode, "coder");
  assert.equal(classifyIntent("Review my project and tell me what to improve first.", project).mode, "inspect");
  assert.equal(classifyIntent("Debug the failing tests in the repo", project).mode, "debug");
  assert.equal(classifyIntent("Atlas, can you fix the broken login page in my app?", project).kind, "project_task");
  // Polite questions that do not point at the project stay conversation.
  assert.equal(classifyIntent("Can you write a haiku about autumn?", project).kind, "chat");
  // Without a connected project there is nothing to work on.
  assert.equal(classifyIntent("Fix the login bug in my project", { hasProject: false }).kind, "chat");
});

test("computer work is recognized separately from project work", () => {
  assert.equal(classifyIntent("Go to linkedin.com and find three product manager jobs in Denver", project).kind, "computer_task");
  assert.equal(classifyIntent("Open https://example.com and fill out the contact form", project).kind, "computer_task");
  assert.equal(classifyIntent("Take a screenshot of my desktop", project).kind, "computer_task");
  assert.equal(classifyIntent("Log into my bank", { hasProject: false }).kind, "computer_task");
  assert.equal(classifyIntent("How do I open a PDF in Edge?", project).kind, "chat");
});

test("the delta parser handles arbitrary chunk splits, arrays and [DONE]", () => {
  const parser = createDeltaParser();
  const stream = 'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\ndata: {"choices":[{"delta":{"content":"lo"}}]}\n\n: keep-alive\n\ndata: {"choices":[{"delta":{"content":[{"text":" there"}]}}]}\n\ndata: [DONE]\n\n';
  const out = [];
  for (let i = 0; i < stream.length; i += 7) out.push(...parser.push(stream.slice(i, i + 7)));
  assert.equal(out.join(""), "Hello there");
  assert.equal(parser.done, true);
  assert.deepEqual(createDeltaParser().push("data: not json\n"), []);
});

test("Atlas events round-trip through the browser parser", () => {
  const parser = createEventParser();
  const wire = encodeEvent("meta", { conversationId: "c" }) + encodeEvent("delta", { text: "a\nb" }) + encodeEvent("done", { stored: true });
  const events = [...parser.push(wire.slice(0, 10)), ...parser.push(wire.slice(10))];
  assert.deepEqual(events.map((e) => e.type), ["meta", "delta", "done"]);
  assert.equal(events[1].data.text, "a\nb");
});
