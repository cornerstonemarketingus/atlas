import assert from "node:assert/strict";
import test from "node:test";
import { taskDiagnostic } from "../app/api/tasks/task-diagnostics.mjs";

test("taskDiagnostic logs a structured, parseable record without the objective text", () => {
  const logged = [];
  const original = console.warn;
  console.warn = (line) => logged.push(JSON.parse(String(line)));
  try {
    const record = taskDiagnostic("task.history_not_saved", {
      taskId: "t1", correlationId: "cor_abc", repository: "cornerstonemarketingus/atlas", mode: "coder", executionProvider: "managed",
    });
    assert.deepEqual(record, {
      atlas: "tasks", event: "task.history_not_saved",
      taskId: "t1", correlationId: "cor_abc", repository: "cornerstonemarketingus/atlas", mode: "coder", executionProvider: "managed",
    });
    assert.deepEqual(logged, [record]);
  } finally {
    console.warn = original;
  }
});

test("a logging failure never throws back into the caller", () => {
  const original = console.warn;
  console.warn = () => { throw new Error("stdout closed"); };
  try {
    assert.doesNotThrow(() => taskDiagnostic("task.history_not_saved", { taskId: "t1" }));
  } finally {
    console.warn = original;
  }
});

test("a task-history write failure is logged, not silently swallowed", async () => {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(new URL("../app/api/tasks/route.ts", import.meta.url), "utf8");
  assert.match(source, /taskDiagnostic\("task\.history_not_saved", \{ taskId, correlationId, repository: task\.repository, mode: task\.mode, executionProvider \}\)/u);
});
