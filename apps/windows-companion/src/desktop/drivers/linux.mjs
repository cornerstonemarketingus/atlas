import { execFile } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { DesktopError } from "../actions.mjs";

/**
 * X11 desktop driver (xdotool, wmctrl, ImageMagick `import`, xclip).
 *
 * Every tool is started with execFile and an argument vector — never a
 * shell — so text the model proposes can only ever be data. Used on Linux
 * workstations and in CI under Xvfb, where it gives the desktop operator a
 * real screen to be tested against.
 */

const XDOTOOL_KEYS = {
  ctrl: "ctrl", alt: "alt", shift: "shift", win: "super", enter: "Return", tab: "Tab", esc: "Escape", space: "space",
  backspace: "BackSpace", delete: "Delete", home: "Home", end: "End", pageup: "Prior", pagedown: "Next",
  up: "Up", down: "Down", left: "Left", right: "Right", insert: "Insert",
};

export function xdotoolKeys(keys) {
  return keys.split("+").map((k) => XDOTOOL_KEYS[k] ?? (/^f\d{1,2}$/u.test(k) ? k.toUpperCase() : k)).join("+");
}

function run(file, args, { input, timeoutMs = 15_000, env } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(file, args, { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, encoding: "buffer", env }, (error, stdout, stderr) => {
      if (error) {
        const missing = error.code === "ENOENT";
        reject(new DesktopError(missing ? "TOOL_MISSING" : "DRIVER_FAILED",
          missing ? `${file} is not installed.` : `${file} failed: ${String(stderr).trim().slice(0, 300) || error.message}`,
          missing ? { blocked: "BLOCKED_BY_CAPABILITY", unblock: `Install ${file} (e.g. apt install xdotool wmctrl imagemagick xclip).` } : {}));
        return;
      }
      resolve(stdout);
    });
    if (input !== undefined) child.stdin.end(input);
  });
}

export function createLinuxDriver({ env = process.env } = {}) {
  if (!env.DISPLAY) {
    throw new DesktopError("NO_DISPLAY", "No X display is available to operate.", { blocked: "BLOCKED_BY_CAPABILITY", unblock: "Run the companion inside a desktop session (DISPLAY must be set)." });
  }
  const childEnv = { PATH: env.PATH, DISPLAY: env.DISPLAY, HOME: env.HOME, XAUTHORITY: env.XAUTHORITY ?? "" };
  const x = (file, args, options = {}) => run(file, args, { env: childEnv, ...options });

  const name = async (id) => String(await x("xdotool", ["getwindowname", id]).catch(() => Buffer.from(""))).trim();

  // Without a window manager (bare Xvfb, kiosk sessions) there is no
  // _NET_ACTIVE_WINDOW; the X input focus is the next best answer.
  async function activeWindow() {
    for (const args of [["getactivewindow"], ["getwindowfocus"]]) {
      try {
        const id = String(await x("xdotool", args)).trim();
        if (id) return { id, title: await name(id) };
      } catch { /* try the next source */ }
    }
    return { id: null, title: "" };
  }

  async function listWithoutWindowManager() {
    const ids = String(await x("xdotool", ["search", "--onlyvisible", "--name", "."]).catch(() => Buffer.from(""))).split("\n").filter(Boolean).slice(0, 60);
    const out = [];
    for (const id of ids) {
      const title = await name(id);
      if (title) out.push({ id, desktop: 0, bounds: null, title });
    }
    return out;
  }

  return {
    platform: "linux",
    async screenshot() {
      const file = join(tmpdir(), `atlas-shot-${randomUUID()}.png`);
      try {
        await x("import", ["-window", "root", file]);
        return await readFile(file);
      } finally {
        await rm(file, { force: true });
      }
    },
    async windows() {
      const out = String(await x("wmctrl", ["-l", "-G"]).catch(() => Buffer.from("")));
      if (!out.trim()) return listWithoutWindowManager();
      return out.split("\n").filter(Boolean).map((line) => {
        const [id, desktop, left, top, width, height, , ...title] = line.trim().split(/\s+/u);
        return { id, desktop: Number(desktop), bounds: { x: Number(left), y: Number(top), width: Number(width), height: Number(height) }, title: title.join(" ") };
      }).filter((w) => w.desktop >= 0);
    },
    activeWindow,
    async inspect() {
      // X11 has no universal accessibility tree; the focused window's name and geometry are what is reliable.
      const active = await activeWindow();
      if (!active.id) return { window: null, tree: [] };
      const geometry = String(await x("xdotool", ["getwindowgeometry", active.id]).catch(() => Buffer.from("")));
      return { window: active, tree: [], geometry: geometry.trim() };
    },
    async focus(title) {
      const out = String(await x("xdotool", ["search", "--name", "--limit", "1", title]).catch(() => Buffer.from(""))).trim();
      if (!out) throw new DesktopError("WINDOW_NOT_FOUND", `No window titled like “${title}”.`);
      const id = out.split("\n")[0];
      try {
        await x("xdotool", ["windowactivate", "--sync", id]);
      } catch {
        await x("xdotool", ["windowraise", id]).catch(() => {});
        await x("xdotool", ["windowfocus", "--sync", id]);
      }
      return { id, title: await name(id) };
    },
    async click({ x: px, y: py, button, double }) {
      const code = { left: "1", middle: "2", right: "3" }[button] ?? "1";
      await x("xdotool", ["mousemove", "--sync", String(px), String(py), "click", ...(double ? ["--repeat", "2"] : []), code]);
    },
    async move({ x: px, y: py }) { await x("xdotool", ["mousemove", "--sync", String(px), String(py)]); },
    async type(text) { await x("xdotool", ["type", "--delay", "12", "--", text], { timeoutMs: 60_000 }); },
    async key(keys) { await x("xdotool", ["key", "--clearmodifiers", xdotoolKeys(keys)]); },
    async scroll({ dx, dy }) {
      const clicks = [];
      if (dy) clicks.push(["click", "--repeat", String(Math.abs(dy)), dy > 0 ? "5" : "4"]);
      if (dx) clicks.push(["click", "--repeat", String(Math.abs(dx)), dx > 0 ? "7" : "6"]);
      for (const args of clicks) await x("xdotool", args);
    },
    async launch(app) {
      const { spawn } = await import("node:child_process");
      const child = spawn(app, [], { env: childEnv, detached: true, stdio: "ignore" });
      await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", () => reject(new DesktopError("APP_NOT_FOUND", `${app} could not be started.`))); });
      child.unref();
    },
    async clipboardRead() { return String(await x("xclip", ["-selection", "clipboard", "-o"]).catch(() => Buffer.from(""))); },
    async clipboardWrite(text) { await x("xclip", ["-selection", "clipboard", "-i"], { input: text }); },
  };
}
