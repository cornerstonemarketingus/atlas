import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";
import { readTaskRequests, requestExplanation } from "../app/build/request-inspection-client.mjs";

const key = "11111111-1111-4111-8111-111111111111";
const saved = (objective) => ({ requestKey: key, createdAt: "2026-10-17 00:00:00", state: "task-saved", receiptState: "reserved", outcomeStatus: null,
  task: { taskId: key, conversationId: key, repository: "owner/repo", branch: "main", objective, dispatchState: "unknown" } });
const settle = () => new Promise(resolve => setImmediate(resolve));

// Run the actual component and real GET client. Deferred responses deliberately
// ignore cancellation so fencing, not transport cooperation, determines safety.
function history() {
  const slots = []; const pendingEffects = []; const requests = []; const timers = new Map();
  let index = 0; let timerId = 0; let mounted = true; let writesAfterUnmount = 0; let version = 0;
  const fetcher = (url, options) => new Promise((resolve, reject) => requests.push({ url, options, resolve, reject }));
  const react = {
    useState(initial) {
      const slot = index++;
      if (!(slot in slots)) slots[slot] = typeof initial === "function" ? initial() : initial;
      return [slots[slot], value => { if (!mounted) { writesAfterUnmount++; return; } slots[slot] = typeof value === "function" ? value(slots[slot]) : value; }];
    },
    useRef(initial) { return slots[index++] ??= { current: initial }; },
    useEffect(setup, dependencies) {
      const slot = index++; const previous = slots[slot];
      if (previous && dependencies.every((value, i) => Object.is(value, previous.dependencies[i]))) return;
      const next = { dependencies, cleanup: null }; slots[slot] = next;
      pendingEffects.push(() => { previous?.cleanup?.(); next.cleanup = setup(); });
    },
  };
  const output = ts.transpileModule(readFileSync(new URL("../app/build/RequestHistory.tsx", import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const exports = {};
  const document = { hidden: false };
  vm.runInNewContext(output, {
    exports, AbortController, document,
    setInterval(callback) { const id = ++timerId; timers.set(id, callback); return id; },
    clearInterval(id) { timers.delete(id); },
    require(name) {
      if (name === "react") return react;
      if (name === "react/jsx-runtime") return { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) };
      if (name.endsWith("request-inspection-client.mjs")) return { requestExplanation, readTaskRequests: options => readTaskRequests({ ...options, fetcher }) };
      if (name.endsWith(".css")) return {};
      throw new Error(`Unexpected component import: ${name}`);
    },
  });
  function render() { index = 0; return exports.RequestHistory({ version }); }
  function commit() { render(); while (pendingEffects.length) pendingEffects.shift()(); return render(); }
  function nodes(node, type) {
    if (!node || typeof node !== "object") return [];
    return [...(node.type === type ? [node] : []), ...[node.props?.children].flat(Infinity).flatMap(child => nodes(child, type))];
  }
  function button(label) { return nodes(render(), "button").find(node => [node.props.children].flat().includes(label)); }
  commit();
  return {
    requests, document,
    toggle(open) { render().props.onToggle({ currentTarget: { open } }); commit(); },
    rapidReopen() { const toggle = render().props.onToggle; toggle({ currentTarget: { open: false } }); toggle({ currentTarget: { open: true } }); commit(); },
    click(label) { const target = button(label); assert.ok(target, label); assert.equal(target.props.disabled, false, label); target.props.onClick(); commit(); },
    poll() { for (const callback of [...timers.values()]) callback(); commit(); },
    update() { version++; commit(); },
    page(n, objective, nextCursor = null) { requests[n].resolve(Response.json({ requests: [saved(objective)], nextCursor })); },
    detail(n, objective) { requests[n].resolve(Response.json({ request: saved(objective) })); },
    text() { return JSON.stringify(render()); },
    unmount() { mounted = false; for (const slot of slots) slot?.cleanup?.(); },
    writesAfterUnmount: () => writesAfterUnmount,
  };
}

test("saved-request polling is single-flight and skips hidden tabs", async () => {
  const panel = history(); panel.toggle(true);
  panel.poll(); panel.poll();
  assert.equal(panel.requests.length, 1, "pending page reads must not overlap");
  panel.page(0, "Initial"); await settle();
  panel.document.hidden = true; panel.poll(); assert.equal(panel.requests.length, 1);
  panel.document.hidden = false; panel.poll(); assert.equal(panel.requests.length, 2);
  panel.page(1, "Latest"); await settle();
  assert.match(panel.text(), /Latest/);
  assert.ok(panel.requests.every(request => request.options.method === "GET" && request.options.body === undefined));
  panel.unmount();
});

for (const outcome of ["success", "failure"]) {
  test(`a late detail ${outcome} cannot replace reopened request history`, async () => {
    const panel = history(); panel.toggle(true); panel.page(0, "Old page"); await settle();
    panel.click("Check request"); assert.equal(panel.requests.length, 2);
    panel.toggle(false);
    assert.equal(panel.requests[1].options.signal?.aborted, true, "closing aborts the detail read");
    panel.toggle(true); panel.page(2, "Reopened page"); await settle();
    if (outcome === "success") panel.detail(1, "STALE_DETAIL"); else panel.requests[1].reject(new Error("old request failed"));
    await settle();
    assert.match(panel.text(), /Reopened page/);
    assert.doesNotMatch(panel.text(), /STALE_DETAIL|This request is unavailable/);
    panel.unmount();
  });
}

test("a poll cannot overwrite an in-flight detail check", async () => {
  const panel = history(); panel.toggle(true); panel.page(0, "Initial"); await settle();
  panel.click("Check request"); panel.poll();
  assert.equal(panel.requests.length, 2, "do not overlap list and detail snapshots");
  panel.detail(1, "Checked"); await settle(); assert.match(panel.text(), /Checked/);
  panel.unmount();
});

test("refresh fences a late detail failure without erasing the refreshed history", async () => {
  const panel = history(); panel.toggle(true); panel.page(0, "Initial"); await settle();
  panel.click("Check request"); panel.click("Refresh requests");
  panel.page(2, "Refreshed"); await settle();
  panel.requests[1].reject(new Error("late failure")); await settle();
  assert.match(panel.text(), /Refreshed/); assert.doesNotMatch(panel.text(), /This request is unavailable/);
  panel.unmount();
});

test("unmount aborts a detail request and prevents all later state writes", async () => {
  const panel = history(); panel.toggle(true); panel.page(0, "Initial"); await settle();
  panel.click("Check request"); panel.unmount(); panel.detail(1, "STALE_DETAIL"); await settle();
  assert.equal(panel.requests[1].options.signal?.aborted, true);
  assert.equal(panel.writesAfterUnmount(), 0);
});

test("paging cancels a detail check before an older page becomes visible", async () => {
  const panel = history(); panel.toggle(true); panel.page(0, "Newer page", "older-page"); await settle();
  panel.click("Check request"); panel.click("Older");
  assert.equal(panel.requests[1].options.signal.aborted, true);
  assert.match(panel.requests[2].url, /cursor=older-page/);
  panel.page(2, "Older page"); await settle();
  panel.detail(1, "STALE_DETAIL"); await settle();
  assert.match(panel.text(), /Older page/); assert.doesNotMatch(panel.text(), /STALE_DETAIL/);
  panel.unmount();
});

test("a changed history version fences the previous detail response", async () => {
  const panel = history(); panel.toggle(true); panel.page(0, "Initial"); await settle();
  panel.click("Check request"); panel.update();
  panel.page(2, "Updated history"); await settle();
  panel.detail(1, "STALE_DETAIL"); await settle();
  assert.match(panel.text(), /Updated history/); assert.doesNotMatch(panel.text(), /STALE_DETAIL/);
  assert.equal(panel.requests[1].options.signal.aborted, true);
  panel.unmount();
});

test("batched close and reopen starts a fresh history session", async () => {
  const panel = history(); panel.toggle(true); panel.page(0, "Initial"); await settle();
  panel.click("Check request"); panel.rapidReopen();
  assert.equal(panel.requests.length, 3, "reopening must not leave the cancelled session inert");
  panel.page(2, "Reopened"); await settle();
  panel.detail(1, "STALE_DETAIL"); await settle();
  assert.match(panel.text(), /Reopened/); assert.doesNotMatch(panel.text(), /STALE_DETAIL/);
  panel.unmount();
});
