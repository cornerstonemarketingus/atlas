import assert from "node:assert/strict";
import test from "node:test";

import { ToolRegistry } from "../src/agent/tool-registry.mjs";
import { registerDesktopTools } from "../src/agent/tools/desktop-tools.mjs";
import { DesktopSession } from "../../windows-companion/src/desktop/index.mjs";

function fakeDriver() {
  const calls = [];
  return {
    calls,
    screenshot: async () => Buffer.from(`png-${calls.length}`),
    windows: async () => [{ id: "1", title: "Untitled - Notepad" }],
    activeWindow: async () => ({ id: "1", title: "Untitled - Notepad" }),
    inspect: async () => ({ window: { title: "Untitled - Notepad" }, tree: [] }),
    focus: async (title) => { calls.push(["focus", title]); return { title }; },
    click: async () => {}, move: async () => {}, scroll: async () => {}, launch: async () => {},
    type: async (text) => { calls.push(["type", text]); },
    key: async (keys) => { calls.push(["key", keys]); },
    clipboardRead: async () => "copied", clipboardWrite: async () => {},
  };
}

const run = (registry, name, args, approvals = null) => registry.invoke({ name, rawArguments: JSON.stringify(args), sessionId: "s1", approvals });

test("desktop tools act through the shared session rules and local policy", async () => {
  const driver = fakeDriver();
  const pending = [];
  const session = new DesktopSession({
    driver,
    approve: async ({ risk }) => { pending.push(risk.reason); throw Object.assign(new Error("This desktop action needs your approval."), { code: "APPROVAL_REQUIRED" }); },
  });
  const policies = { "desktop.observe": "allow", "desktop.control": "allow" };
  const registry = new ToolRegistry({ policy: (capability) => policies[capability] ?? "deny" });
  registerDesktopTools(registry, { session });

  const observed = await run(registry, "desktop.observe", {});
  assert.equal(observed.status, "completed");
  assert.match(observed.output, /Untitled - Notepad/u);

  const typed = await run(registry, "desktop.act", { action: { type: "desktop_type", text: "Hello" } });
  assert.equal(typed.status, "completed");
  assert.match(typed.output, /Evidence: sha256:/u);
  assert.deepEqual(driver.calls.at(-1), ["type", "Hello"]);

  // Session rules still ask for consequential steps even when the tool is allowed.
  const closing = await run(registry, "desktop.act", { action: { type: "desktop_key", keys: "alt+f4" } });
  assert.equal(closing.status, "failed");
  assert.equal(closing.code, "APPROVAL_REQUIRED");
  assert.deepEqual(pending, ["Press alt+f4 in “Untitled - Notepad”"]);
  assert.ok(!driver.calls.some(([op, k]) => op === "key" && k === "alt+f4"));

  // Local policy governs the capability as a whole.
  policies["desktop.control"] = "deny";
  assert.equal((await run(registry, "desktop.act", { action: { type: "desktop_key", keys: "ctrl+s" } })).code, "POLICY_DENIED");
  policies["desktop.observe"] = "ask";
  assert.equal((await run(registry, "desktop.screenshot", {})).status, "approval-required");
  assert.equal((await run(registry, "desktop.act", { action: { type: "shell" } })).code, "INVALID_INPUT");
});

test("a machine without a desktop answers with the reason and the fix", async () => {
  const registry = new ToolRegistry({ policy: () => "allow" });
  registerDesktopTools(registry, { session: async () => { throw Object.assign(new Error("No X display is available to operate."), { unblock: "Run inside a desktop session." }); } });
  const result = await run(registry, "desktop.observe", {});
  assert.equal(result.status, "failed");
  assert.equal(result.code, "NO_DESKTOP");
  assert.match(result.message, /No X display.*Run inside a desktop session/u);
});
