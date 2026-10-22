import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as jsxRuntime from "react/jsx-runtime";
import * as polling from "../app/chat/activity-poll.mjs";
import { statusLine } from "../app/build/task-presentation.mjs";

// Transpile and render the real chat component, with its actual presentation
// and status normalization. Server rendering does not start polling effects.
const output = ts.transpileModule(readFileSync(new URL("../app/chat/TaskActivity.tsx", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
const exports = {};
vm.runInNewContext(output, { exports, require(name) {
  if (name === "react") return React;
  if (name === "react/jsx-runtime") return jsxRuntime;
  if (name.endsWith("activity-poll.mjs")) return polling;
  if (name.endsWith("task-presentation.mjs")) return { statusLine };
  if (name.endsWith("AtlasMark.js")) return { AtlasMark: () => null };
  if (name.endsWith("MessageBody.js")) return { DiffLines: () => null };
  throw new Error(`Unexpected import: ${name}`);
} });
function screen(overrides = {}) {
  return renderToStaticMarkup(React.createElement(exports.TaskActivity, { task: {
    taskId: "example", objective: "Run the test suite and report failures", mode: "coder", status: "succeeded", ...overrides,
  } }));
}

test("successful operational workflow points to actual test evidence without requiring a PR", () => {
  const html = screen();
  assert.match(html, /Coder run/);
  assert.match(html, /completed work, test coverage and failures/);
  assert.match(html, /No pull request was created/);
  assert.match(html, /Step details are unavailable/);
  assert.doesNotMatch(html, /Changing code|change is ready|tests passed|Waiting for GitHub|Cancel run/);
});

test("a coding request without a PR keeps the unconfirmed change wording", () => {
  const html = screen({ objective: "Fix the TODO in the about page" });
  assert.match(html, /No pull request was created/);
  assert.doesNotMatch(html, /tests passed|change is ready|reported test execution results/);
});

test("a PR is reviewable evidence, not proof of a verified objective", () => {
  const html = screen({ pullRequest: { number: 42, url: "https://github.com/owner/repo/pull/42", merged: false } });
  assert.match(html, /pull request is available/);
  assert.match(html, /Review its changes and validation evidence/);
  assert.match(html, /Review the pull request/);
  assert.doesNotMatch(html, /change is ready|tests passed/);
});

test("terminal failure, timeout, cancellation, skipped and unknown completion remain distinct", () => {
  for (const [status, expected] of [["failed", /run failed/], ["timed_out", /time limit/], ["cancelled", /run was cancelled/], ["skipped", /run was skipped/], ["completed", /outcome is unconfirmed/]]) {
    const html = screen({ status });
    assert.match(html, expected);
    assert.doesNotMatch(html, /Waiting for run details|Cancel run|change is ready/);
  }
});

test("running and uncertain dispatch retain actionable status without announcing completion", () => {
  assert.match(screen({ status: "running" }), /runner is working/);
  assert.match(screen({ status: "dispatch-unknown" }), /Checking whether the run started/);
  assert.match(screen({ status: "dispatch-pending" }), /Dispatch has not started/);
});
