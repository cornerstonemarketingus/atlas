import assert from "node:assert/strict";
import test from "node:test";

import {
  SCHEMA_VERSION, acceptCorrelationId, assertTransition, canTransition, canonicalJson, defineTool, digest,
  idempotencyKey, isId, newId, taskSchema, validateSchema,
} from "../src/index.mjs";

test("ids carry their kind and are recognized only as that kind", () => {
  const id = newId("task");
  assert.ok(isId(id, "task"));
  assert.equal(isId(id, "agent"), false);
  assert.throws(() => newId("nope"), { code: "UNKNOWN_ID_KIND" });
});

test("a foreign correlation id is replaced rather than trusted", () => {
  const issued = newId("correlation");
  assert.equal(acceptCorrelationId(issued), issued);
  const replaced = acceptCorrelationId("cor_\nforged log line");
  assert.notEqual(replaced, "cor_\nforged log line");
  assert.ok(isId(replaced, "correlation"));
});

test("canonical JSON and digests ignore key order", () => {
  assert.equal(canonicalJson({ b: 1, a: [2, { d: 1, c: 2 }] }), '{"a":[2,{"c":2,"d":1}],"b":1}');
  assert.equal(digest({ a: 1, b: 2 }), digest({ b: 2, a: 1 }));
  assert.equal(
    idempotencyKey({ tenantId: "t", taskId: "x", tool: "browser.navigate", input: { url: "u" } }),
    idempotencyKey({ input: { url: "u" }, tool: "browser.navigate", taskId: "x", tenantId: "t" }),
  );
});

test("the task lifecycle refuses skipping run and verification", () => {
  assert.ok(canTransition("running", "verifying"));
  assert.equal(canTransition("queued", "completed"), false);
  assert.throws(() => assertTransition("queued", "completed"), { code: "ILLEGAL_TRANSITION" });
  assert.throws(() => assertTransition("archived", "running"), { code: "ILLEGAL_TRANSITION" });
});

test("schema validation reports required, extra and typed fields", () => {
  const now = new Date().toISOString();
  const task = {
    schemaVersion: SCHEMA_VERSION, id: newId("task"), tenantId: "t1", userId: "u1", correlationId: newId("correlation"),
    objective: "Read a value", status: "proposed", successCriteria: ["value extracted"], budget: { toolCalls: 3 },
    createdAt: now, updatedAt: now,
  };
  assert.deepEqual(validateSchema(taskSchema, task), []);
  const errors = validateSchema(taskSchema, { ...task, status: "done", extra: 1, successCriteria: [] });
  const paths = errors.map((e) => e.path).sort();
  assert.deepEqual(paths, ["$.extra", "$.status", "$.successCriteria"]);
});

test("tool definitions must be well formed", () => {
  const tool = defineTool({ name: "browser.navigate", description: "d", risk: "low", inputSchema: { type: "object" }, execute: async () => ({}) });
  assert.equal(tool.consequential, false);
  assert.throws(() => defineTool({ name: "Navigate", description: "d", risk: "low", inputSchema: { type: "object" }, execute() {} }), { code: "INVALID_TOOL" });
  assert.throws(() => defineTool({ name: "a.b", description: "d", risk: "yolo", inputSchema: { type: "object" }, execute() {} }), { code: "INVALID_TOOL" });
});
