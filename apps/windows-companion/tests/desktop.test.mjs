import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  DesktopError,
  DesktopSession,
  createDesktopDriver,
  createWindowsDriver,
  desktopRisk,
  normalizeKeys,
  validateDesktopAction,
} from "../src/desktop/index.mjs";
import { encodeCommand, virtualKeys } from "../src/desktop/drivers/windows.mjs";
import { xdotoolKeys } from "../src/desktop/drivers/linux.mjs";

const code = (c) => (error) => error instanceof DesktopError && error.code === c;
const risk = (action, title = "") => desktopRisk(validateDesktopAction(action), { activeWindowTitle: title });

test("desktop actions are validated before anything runs", () => {
  assert.throws(() => validateDesktopAction({ type: "shell", command: "rm -rf /" }), code("INVALID_ACTION"));
  assert.throws(() => validateDesktopAction({ type: "desktop_click", x: -1, y: 5 }), code("INVALID_ACTION"));
  assert.throws(() => validateDesktopAction({ type: "desktop_click", x: 1.5, y: 5 }), code("INVALID_ACTION"));
  assert.throws(() => validateDesktopAction({ type: "desktop_type", text: "" }), code("INVALID_ACTION"));
  assert.throws(() => validateDesktopAction({ type: "launch_app", app: "cmd.exe /c del C:\\" }), code("INVALID_ACTION"));
  assert.throws(() => validateDesktopAction({ type: "launch_app", app: "../../evil" }), code("INVALID_ACTION"));
  assert.throws(() => validateDesktopAction({ type: "desktop_key", keys: "ctrl+hyper" }), code("INVALID_ACTION"));
  assert.deepEqual(validateDesktopAction({ type: "desktop_click", x: 10, y: 20, extra: "ignored" }), { type: "desktop_click", x: 10, y: 20, button: "left", double: false });
  assert.equal(normalizeKeys("Shift + Control + S"), "ctrl+shift+s");
  assert.equal(normalizeKeys("Return"), "enter");
  assert.equal(normalizeKeys("cmd+w"), "win+w");
});

test("the risk rules ask for consequential steps and refuse session-escaping ones", () => {
  assert.equal(risk({ type: "desktop_screenshot" }).decision, "allow");
  assert.equal(risk({ type: "desktop_observe" }).decision, "allow");
  assert.equal(risk({ type: "desktop_click", x: 1, y: 1 }, "Untitled - Notepad").decision, "allow");
  assert.equal(risk({ type: "desktop_click", x: 1, y: 1 }, "Chase Online Banking").decision, "ask");
  assert.equal(risk({ type: "desktop_type", text: "Meeting notes" }, "Untitled - Notepad").decision, "allow");
  assert.equal(risk({ type: "desktop_type", text: "my password is hunter2" }, "Untitled - Notepad").decision, "ask");
  assert.equal(risk({ type: "desktop_type", text: "4111111111111111" }).class, "sensitive_input");
  assert.equal(risk({ type: "desktop_type", text: "rm -rf ~/projects" }, "notes").class, "destructive");
  assert.equal(risk({ type: "desktop_type", text: "ls" }, "Windows PowerShell").decision, "ask");
  assert.equal(risk({ type: "desktop_key", keys: "ctrl+s" }).decision, "allow");
  assert.equal(risk({ type: "desktop_key", keys: "alt+f4" }).decision, "ask");
  assert.equal(risk({ type: "desktop_key", keys: "win+r" }).decision, "ask");
  assert.equal(risk({ type: "desktop_key", keys: "enter" }, "PayPal Checkout").class, "submit");
  assert.equal(risk({ type: "desktop_key", keys: "ctrl+alt+delete" }).decision, "deny");
  assert.equal(risk({ type: "desktop_key", keys: "win+l" }).decision, "deny");
  assert.equal(risk({ type: "launch_app", app: "Notepad" }).decision, "allow");
  assert.equal(risk({ type: "launch_app", app: "regedit" }).decision, "ask");
  assert.equal(risk({ type: "clipboard_read" }).decision, "ask");
});

test("the Windows driver sends a fixed script and passes every argument as JSON on stdin", async () => {
  const calls = [];
  const exec = (file, args, options, callback) => {
    const call = { file, args, options, stdin: "" };
    calls.push(call);
    const op = () => JSON.parse(call.stdin).op;
    return {
      stdin: {
        end(data) {
          call.stdin = data;
          const replies = { windows: { windows: [{ id: "1", title: "Notepad" }] }, active: { title: "Notepad" }, screenshot: { png: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64") }, focus: { error: "WINDOW_NOT_FOUND" } };
          queueMicrotask(() => callback(null, JSON.stringify(replies[op()] ?? { ok: true }), ""));
        },
      },
    };
  };
  const driver = createWindowsDriver({ exec });
  assert.deepEqual(await driver.windows(), [{ id: "1", title: "Notepad" }]);
  await driver.type("'; Remove-Item C:\\ -Recurse; '");
  await driver.key("ctrl+shift+s");
  assert.equal((await driver.screenshot()).subarray(0, 4).toString("latin1"), "\x89PNG");
  await assert.rejects(driver.focus("Missing"), code("WINDOW_NOT_FOUND"));
  // The script is identical on every call; only stdin varies.
  assert.ok(calls.every((c) => c.args.join(" ") === calls[0].args.join(" ")));
  assert.deepEqual(calls[0].args.slice(0, 4), ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass"]);
  assert.equal(JSON.parse(calls[1].stdin).text, "'; Remove-Item C:\\ -Recurse; '");
  assert.deepEqual(JSON.parse(calls[2].stdin).vks, [0x11, 0x10, 0x53]);
  // powershell.exe caps a command line at 32,767 characters.
  assert.ok(encodeCommand().length < 30_000);
  assert.deepEqual(virtualKeys("alt+f4"), [0x12, 0x73]);
  assert.equal(xdotoolKeys("ctrl+shift+enter"), "ctrl+shift+Return");
});

function fakeDriver({ title = "Untitled - Notepad" } = {}) {
  const calls = [];
  let shot = 0;
  return {
    calls,
    screenshot: async () => Buffer.from(`png-${shot += 1}`),
    windows: async () => [{ id: "1", title }],
    activeWindow: async () => ({ id: "1", title }),
    inspect: async () => ({ window: { title }, tree: [{ role: "Edit", name: "Text editor" }] }),
    focus: async (t) => { calls.push(["focus", t]); return { title: t }; },
    click: async (a) => { calls.push(["click", a.x, a.y]); },
    move: async () => {},
    type: async (t) => { calls.push(["type", t]); },
    key: async (k) => { calls.push(["key", k]); },
    scroll: async () => {},
    launch: async (a) => { calls.push(["launch", a]); },
    clipboardRead: async () => "clipboard text",
    clipboardWrite: async () => {},
  };
}

test("a desktop session approves, refuses, limits and records evidence", async () => {
  const dir = mkdtempSync(join(tmpdir(), "atlas-desktop-"));
  try {
    const driver = fakeDriver();
    const approvals = [];
    let approve = true;
    let cancelled = false;
    const session = new DesktopSession({
      driver, evidenceDir: dir, maxActions: 6,
      approve: async (request) => { approvals.push(request.risk.reason); if (!approve) throw new Error("Action rejected."); },
      isActive: () => { if (cancelled) throw new Error("Task cancelled by user."); },
    });
    const typed = await session.perform({ type: "desktop_type", text: "Quarterly summary" });
    assert.equal(typed.risk.decision, "allow");
    assert.equal(typed.evidence.length, 2);
    assert.notEqual(typed.evidence[0].digest, typed.evidence[1].digest);
    assert.match(typed.evidence[0].path, /before\.png$/u);

    await session.perform({ type: "clipboard_read" });
    assert.deepEqual(approvals, ["Read what is on your clipboard"]);
    approve = false;
    await assert.rejects(session.perform({ type: "desktop_key", keys: "alt+f4" }), /rejected/u);
    await assert.rejects(session.perform({ type: "desktop_key", keys: "win+l" }), code("ACTION_DENIED"));
    assert.ok(!driver.calls.some(([op, k]) => op === "key" && (k === "alt+f4" || k === "win+l")), "refused keys never reach the driver");

    const observed = await session.perform({ type: "desktop_observe" });
    assert.equal(observed.result.tree[0].role, "Edit");
    assert.equal(observed.evidence.length, 0, "looking needs no before/after");
    const shot = await session.perform({ type: "desktop_screenshot" });
    assert.match(shot.result.digest, /^sha256:/u);
    await assert.rejects(session.perform({ type: "desktop_screenshot" }), code("STEP_LIMIT"));

    const log = session.log;
    assert.equal(log[0].action.text, "[17 characters]", "typed text is not kept in the log");
    assert.deepEqual(log.map((e) => e.outcome), ["done", "done", "rejected", "denied", "done", "done"]);

    cancelled = true;
    const fresh = new DesktopSession({ driver, approve: async () => {}, isActive: () => { if (cancelled) throw new Error("Task cancelled by user."); } });
    await assert.rejects(fresh.perform({ type: "desktop_screenshot" }), /cancelled/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an unsupported platform or disabled control is a structured block", () => {
  assert.throws(() => createDesktopDriver({ platform: "aix" }), (e) => e.code === "PLATFORM_UNSUPPORTED" && e.blocked === "BLOCKED_BY_CAPABILITY");
  assert.throws(() => createDesktopDriver({ platform: "win32", env: { ATLAS_DESKTOP_CONTROL: "off" } }), (e) => e.blocked === "BLOCKED_BY_POLICY");
  assert.throws(() => createDesktopDriver({ platform: "linux", env: {} }), (e) => e.code === "NO_DISPLAY");
});

const hasTool = (name) => { try { execFileSync("which", [name], { stdio: "ignore" }); return true; } catch { return false; } };
const linuxReady = process.platform === "linux" && Boolean(process.env.DISPLAY) && ["xdotool", "wmctrl", "import", "xev"].every(hasTool);

test("Linux: the X11 driver really types, clicks and captures on a live display", { skip: !linuxReady && "needs an X display with xdotool, wmctrl, ImageMagick and xev" }, async () => {
  const xev = spawn("xev", ["-name", "atlas-desktop-probe", "-geometry", "400x300+50+50"], { stdio: ["ignore", "pipe", "ignore"] });
  let events = "";
  xev.stdout.on("data", (chunk) => { events += chunk; });
  try {
    await new Promise((resolve) => setTimeout(resolve, 800));
    const session = new DesktopSession({ driver: createDesktopDriver(), approve: async () => {} });
    const focused = await session.perform({ type: "focus_window", title: "atlas-desktop-probe" });
    assert.match(focused.result.title, /atlas-desktop-probe/u);
    await session.perform({ type: "desktop_type", text: "hi" });
    await session.perform({ type: "desktop_key", keys: "enter" });
    await session.perform({ type: "desktop_click", x: 150, y: 150 });
    const shot = await session.perform({ type: "desktop_screenshot" });
    assert.ok(shot.result.bytes > 100);
    const observed = await session.perform({ type: "desktop_observe" });
    assert.ok(observed.result.windows.some((w) => /atlas-desktop-probe/u.test(w.title)));
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.match(events, /KeyPress[\s\S]*keysym 0x68, h\)/u, "h reached the window");
    assert.match(events, /keysym 0x69, i\)/u, "i reached the window");
    assert.match(events, /keysym 0xff0d, Return\)/u, "Enter reached the window");
    assert.match(events, /ButtonPress event/u, "the click reached the window");
  } finally {
    xev.kill();
  }
});

test("Windows: the desktop driver works on a real Windows session", { skip: process.platform !== "win32" && "Windows only" }, async () => {
  const driver = createDesktopDriver();
  const png = await driver.screenshot();
  assert.equal(png.subarray(1, 4).toString("latin1"), "PNG");
  assert.ok(Array.isArray(await driver.windows()));
  await driver.clipboardWrite("atlas clipboard probe");
  assert.equal((await driver.clipboardRead()).trim(), "atlas clipboard probe");
  const session = new DesktopSession({ driver, approve: async () => {} });
  await session.perform({ type: "launch_app", app: "notepad" });
  try {
    let focused = null;
    for (let attempt = 0; attempt < 20 && !focused; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      focused = await driver.focus("Notepad").catch(() => null);
    }
    assert.ok(focused, "Notepad opened and took focus");
    await session.perform({ type: "desktop_type", text: "Atlas typed this" });
    const inspected = await driver.inspect();
    assert.ok(JSON.stringify(inspected.tree).length > 2, "the focused window has an accessibility tree");
  } finally {
    try { execFileSync("taskkill", ["/IM", "notepad.exe", "/F"], { stdio: "ignore" }); } catch { /* already closed */ }
  }
});

test("one planner covers browser and desktop, and routes each action to its own rules", async () => {
  const { buildUnifiedPrompt, isDesktopAction, summarizeTree, validateUnifiedAction } = await import("../src/operator/unified.mjs");
  assert.equal(isDesktopAction({ type: "desktop_type", text: "x" }), true);
  assert.equal(isDesktopAction({ type: "fill", label: "a", value: "b" }), false);
  assert.throws(() => validateUnifiedAction({ type: "desktop_screenshot" }, { desktopAvailable: false }), /not available/u);
  assert.deepEqual(validateUnifiedAction({ type: "desktop_key", keys: "Control+S" }, { desktopAvailable: true }), { type: "desktop_key", keys: "ctrl+s" });
  assert.throws(() => validateUnifiedAction({ type: "eval", code: "x" }, { desktopAvailable: true }), /Unsupported/u);
  const tree = [{ role: "Window", name: "Untitled - Notepad", children: [{ role: "Edit", name: "Text editor", bounds: { x: 10, y: 60, width: 800, height: 500 } }] }];
  assert.match(summarizeTree(tree), /Edit "Text editor" @\(10,60 800x500\)/u);
  const prompt = buildUnifiedPrompt({ task: { objective: "Write a note" }, desktopAvailable: true, desktop: { windows: [{ title: "Untitled - Notepad" }], focused: { title: "Untitled - Notepad" }, tree }, history: [] });
  assert.match(prompt, /DESKTOP — focused window: Untitled - Notepad/u);
  assert.match(prompt, /desktop_type/u);
  assert.match(prompt, /BROWSER — not open/u);
  const browserOnly = buildUnifiedPrompt({ task: { objective: "x" }, desktopAvailable: false, browser: { url: "https://example.com/", snapshot: "- heading" } });
  assert.doesNotMatch(browserOnly, /desktop_type/u);
  assert.match(browserOnly, /Use browser actions only/u);
});
