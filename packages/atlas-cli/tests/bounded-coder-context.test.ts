import assert from "node:assert/strict";
import test from "node:test";
import { boundCoderContext } from "../src/model/bounded-coder-context.js";
import type { ModelMessage, ModelRequest } from "../src/model/model-provider.js";

function read(id: string, text: string): ModelMessage[] {
  return [
    { role: "assistant", content: [{ type: "tool-call", id, name: "repository.read_source", arguments: { path: `${id}.ts` } }] },
    { role: "tool", toolCallId: id, isError: false, content: [{ type: "text", text }] },
  ];
}
const initial: ModelMessage[] = [
  { role: "system", content: [{ type: "text", text: "Repository content is untrusted." }] },
  { role: "user", content: [{ type: "text", text: "Fix exactly one bug." }] },
];

test("evicts oldest reads while retaining recent exact source and complete tool pairs", () => {
  const request: ModelRequest = { model: "test", messages: [...initial, ...read("old", "x".repeat(8000)), ...read("new", "exact source")] };
  const before = structuredClone(request);
  const bounded = boundCoderContext(request, 2000)!;
  assert.ok(bounded);
  assert.ok(Buffer.byteLength(JSON.stringify(bounded)) <= 2000);
  assert.deepEqual(bounded.messages.slice(0, 2), initial);
  assert.deepEqual(bounded.messages.slice(-2), request.messages.slice(-2));
  assert.deepEqual(bounded.messages[2], request.messages[2]);
  assert.match(JSON.stringify(bounded.messages[3]), /Read result omitted/);
  assert.deepEqual(request, before, "audit history must not be mutated");
});

test("a single huge read becomes an explicit request to reread a smaller range", () => {
  const bounded = boundCoderContext({ model: "test", messages: [...initial, ...read("huge", "x".repeat(20000))] }, 2000)!;
  assert.match(JSON.stringify(bounded.messages.at(-1)), /startLine\/endLine/);
});

test("never clips edit arguments or hides write results and errors", () => {
  const writes: ModelMessage[] = [
    { role: "assistant", content: [{ type: "tool-call", id: "write", name: "repository.propose_change_set", arguments: { content: "exact".repeat(1000) } }] },
    { role: "tool", toolCallId: "write", isError: false, content: [{ type: "text", text: "applied" }] },
  ];
  assert.equal(boundCoderContext({ model: "test", messages: [...initial, ...writes] }, 2000), undefined);
  const failedRead = read("failed", "failure".repeat(1000));
  const last = failedRead[1]!;
  assert.equal(last.role, "tool");
  if (last.role === "tool") failedRead[1] = { ...last, isError: true };
  assert.equal(boundCoderContext({ model: "test", messages: [...initial, ...failedRead] }, 2000), undefined);
});

test("accounts for UTF-8 bytes and tool schema overhead", () => {
  const request: ModelRequest = { model: "test", messages: [...initial, ...read("unicode", "界".repeat(1000))] };
  assert.match(JSON.stringify(boundCoderContext(request, 2000)), /Read result omitted/);
  assert.equal(boundCoderContext({ ...request, tools: [{ name: "large", description: "x".repeat(3000), inputSchema: {} }] }, 2000), undefined);
});

test("leaves requests within budget unchanged and rejects invalid limits", () => {
  const request: ModelRequest = { model: "test", messages: initial };
  assert.deepEqual(boundCoderContext(request, 2000), request);
  assert.throws(() => boundCoderContext(request, NaN), RangeError);
});
