import assert from "node:assert/strict";
import test from "node:test";

import { renderRunSummary } from "./run-summary.mjs";

const task = {
  task_id: "35001948671-1",
  repository: "cornerstonemarketingus/atlas",
  branch: "main",
  mode: "coder",
  commit: "b337e20951b65bc1b8f7105774c36469279d9011",
};

test("leads with the verdict, because that is the thing being looked for", () => {
  const summary = renderRunSummary({ task, status: { status: "failed", message: "Groq HTTP 413" } });
  assert.match(summary.split("\n")[0] ?? "", /^## Atlas coder — ❌ failed$/u);
  assert.match(summary, /> Groq HTTP 413/u);
});

test("reports how far a run got before it died", () => {
  // The point of the whole file. On a slow self-hosted run these counters are
  // the difference between "the machinery is broken" and "the model is weak",
  // which are different problems with different fixes.
  const summary = renderRunSummary({
    task,
    status: { status: "failed", message: "Request too large" },
    code: { turns: 3, toolCalls: 11, inputTokens: 12077, outputTokens: 480, edits: [] },
  });
  assert.match(summary, /\| Model turns \| 3 \|/u);
  assert.match(summary, /\| Tool calls \| 11 \|/u);
  assert.match(summary, /12,077 in \/ 480 out/u);
});

test("separates failures the change introduced from ones already there", () => {
  // This distinction is the product's entire claim, so it is stated rather
  // than left for the reader to infer from a check list.
  const summary = renderRunSummary({
    task,
    status: { status: "completed" },
    code: {
      edits: [{ path: "src/a.ts", operation: "modified" }],
      verification: {
        status: "regressed",
        attempts: 1,
        checks: ["build", "test"],
        newFailures: ["test: expected 2 to equal 3"],
        message: "1 new failure",
      },
    },
  });
  assert.match(summary, /\*\*regressed\*\* — 1 new failure/u);
  assert.match(summary, /New failures introduced by this change:\*\* 1/u);
  assert.match(summary, /expected 2 to equal 3/u);
  assert.match(summary, /Checks run: `build`, `test`/u);
});

test("lists changed files with what happened to each", () => {
  const summary = renderRunSummary({
    task,
    status: { status: "completed" },
    code: { edits: [{ path: "src/a.ts", operation: "modified" }, { path: "src/b.ts", operation: "created" }] },
  });
  assert.match(summary, /### Files changed \(2\)/u);
  assert.match(summary, /- `src\/a\.ts` — modified/u);
  assert.match(summary, /- `src\/b\.ts` — created/u);
});

test("says so plainly when a completed run changed nothing", () => {
  const summary = renderRunSummary({ task, status: { status: "completed" }, code: { edits: [] } });
  assert.match(summary, /No file changes were proposed\./u);
});

test("renders from nothing at all rather than throwing", () => {
  // A run that dies before writing its artifacts is exactly when a summary is
  // most wanted, so missing input produces a thinner summary, never an error.
  const summary = renderRunSummary();
  assert.match(summary, /## Atlas task — ❔ unknown/u);
  assert.equal(summary.endsWith("\n"), true);
});

test("escapes a pipe so one message cannot break the table", () => {
  // A failure message containing a pipe would silently mangle every row
  // beneath it, which is worse than showing nothing.
  const summary = renderRunSummary({
    task: { ...task, task_id: "a|b" },
    status: { status: "failed", message: "x" },
  });
  assert.match(summary, /\| Task \| `a\\\|b` \|/u);
});

test("collapses newlines inside a cell", () => {
  const summary = renderRunSummary({
    task: { ...task, repository: "owner/repo\nINJECTED" },
    status: { status: "failed" },
  });
  assert.equal(summary.includes("\nINJECTED"), false);
});

test("truncates a runaway message instead of flooding the page", () => {
  const summary = renderRunSummary({ task, status: { status: "failed", message: "x".repeat(5_000) } });
  assert.match(summary, /… \(truncated\)/u);
  assert.ok(summary.length < 3_000, `summary was ${summary.length} characters`);
});

test("caps a runaway edit list", () => {
  const edits = Array.from({ length: 60 }, (_, index) => ({ path: `src/f${index}.ts`, operation: "modified" }));
  const summary = renderRunSummary({ task, status: { status: "completed" }, code: { edits } });
  assert.match(summary, /### Files changed \(60\)/u);
  assert.match(summary, /…and 20 more/u);
});

test("falls back to a readable line for an unrecognised status", () => {
  const summary = renderRunSummary({ task, status: { status: "weird-new-state" } });
  assert.match(summary, /❔ weird-new-state/u);
});
