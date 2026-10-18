import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";
import { activityTaskStatus } from "../app/chat/activity-poll.mjs";

test("the elapsed clock advances while activity polling is unavailable", () => {
  const slots = [], effects = [], timers = [];
  let cursor = 0, now = Date.parse("2026-10-18T03:33:38Z"), polling;
  const react = {
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === "function" ? initial() : initial;
      return [slots[index], value => { slots[index] = typeof value === "function" ? value(slots[index]) : value; }];
    },
    useRef(initial) { const index = cursor++; return slots[index] ??= { current: initial }; },
    useEffect(callback) { effects.push(callback); },
  };
  const output = ts.transpileModule(readFileSync(new URL("../app/chat/TaskActivity.tsx", import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const exports = {};
  vm.runInNewContext(output, {
    exports, Date: class extends Date { static now() { return now; } },
    setInterval: callback => { timers.push(callback); return timers.length; }, clearInterval() {},
    require(name) {
      if (name === "react") return react;
      if (name.includes("activity-poll")) return { activityTaskStatus, pollActivity: options => { polling = options; return () => {}; } };
      if (name === "react/jsx-runtime") return { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) };
      return {};
    },
  });
  function render() {
    cursor = 0;
    return exports.TaskActivity({ task: { taskId: "task", mode: "coder", status: "running", objective: "Fix Atlas" } });
  }
  function text(node) {
    if (typeof node === "string" || typeof node === "number") return String(node);
    if (Array.isArray(node)) return node.map(text).join(" ");
    return node?.props ? text(node.props.children) : "";
  }
  render();
  for (const effect of effects.splice(0)) effect();
  polling.onActivity({ status: "in_progress", steps: [{ label: "Working on it", state: "running", startedAt: "2026-10-18T03:33:15Z", completedAt: null }] });
  assert.match(text(render()), /23s/);
  polling.onUnavailable(true);
  now += 62000;
  for (const tick of timers) tick();
  const visible = text(render());
  assert.match(visible, /1m 25s/);
  assert.match(visible, /Waiting for a status update/);
  assert.match(visible, /last received update/);
  polling.onUnavailable(false);
  polling.onActivity({ status: "completed", conclusion: "success", steps: [] });
  assert.match(text(render()), /Done\. The change is ready/);
});
