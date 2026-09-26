import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { accessSync, constants, existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { createLinuxDriver } from "../../../../../windows-companion/src/desktop/index.mjs";
import { DesktopError } from "../errors.mjs";
import { xwdToPng } from "../png.mjs";

/**
 * Cloud virtual desktop: a private Xvfb display plus the companion's X11
 * driver (apps/windows-companion/src/desktop/drivers/linux.mjs) pointed at it.
 * There is no second X11 input implementation here: pointer, keyboard,
 * windows and focus are the companion driver's (xdotool / wmctrl).
 *
 * What this module adds:
 *   - Lifecycle. Xvfb starts on a free display with a private 0700 temp dir,
 *     an MIT-MAGIC-COOKIE (when `xauth` exists) and no TCP listener. `stop()`
 *     kills Xvfb and every app launched into it and deletes the temp dir.
 *     Nothing is installed.
 *   - Screenshots without ImageMagick: Xvfb's own `-fbdir` framebuffer (an
 *     XWD image) is converted to PNG. The companion driver's `import` path is
 *     used when ImageMagick is present.
 *   - Allowlisted launches: `launch(app)` runs only the configured command
 *     for that app name (never the name as a command), with a private HOME.
 *   - Honest `capabilities()`: input and window listing are reported as
 *     unsupported, with the reason, when xdotool is missing.
 */

export function findExecutable(name, { pathEnv = process.env.PATH ?? "" } = {}) {
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    try { accessSync(candidate, constants.X_OK); return candidate; } catch { /* keep looking */ }
  }
  return null;
}

export function detectXTools({ find = findExecutable } = {}) {
  return { xvfb: find("Xvfb"), xdotool: find("xdotool"), wmctrl: find("wmctrl"), import: find("import"), xclip: find("xclip"), xauth: find("xauth") };
}

function run(file, args, { env } = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { env, timeout: 10_000 }, (error, _stdout, stderr) => {
      if (error) reject(new DesktopError("DRIVER_FAILED", `${file.split("/").at(-1)} failed: ${String(stderr || error.message).split("\n")[0].slice(0, 200)}`));
      else resolve();
    });
  });
}

export class XvfbDisplay {
  #tools;
  #screen;
  #startTimeoutMs;
  #tmpRoot;
  #process = null;
  #dir = null;
  #authFile = null;
  #display = null;

  constructor({ tools = detectXTools(), screen = "1280x800x24", startTimeoutMs = 10_000, tmpRoot = tmpdir() } = {}) {
    this.#tools = tools;
    this.#screen = screen;
    this.#startTimeoutMs = startTimeoutMs;
    this.#tmpRoot = tmpRoot;
  }

  get tools() { return this.#tools; }
  get display() { return this.#display; }
  get directory() { return this.#dir; }
  get pid() { return this.#process?.pid ?? null; }
  get running() { return Boolean(this.#process && this.#process.exitCode === null && this.#process.signalCode === null); }
  get framebufferPath() { return this.#dir ? join(this.#dir, "fb", "Xvfb_screen0") : null; }

  /** The minimal environment every process on this display gets. */
  env(extra = {}) {
    return {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      DISPLAY: this.#display ?? "",
      HOME: this.#dir ? join(this.#dir, "home") : "",
      TMPDIR: this.#dir ? join(this.#dir, "tmp") : "",
      XAUTHORITY: this.#authFile ?? "",
      ...extra,
    };
  }

  async start() {
    if (this.running) return { display: this.#display };
    if (!this.#tools.xvfb) throw new DesktopError("UNSUPPORTED", "Xvfb is not installed.", { blocked: "BLOCKED_BY_CAPABILITY", unblock: "Install Xvfb (apt install xvfb)." });
    this.#dir = await mkdtemp(join(this.#tmpRoot, "atlas-xvfb-"));
    for (const sub of ["home", "tmp", "fb"]) await mkdir(join(this.#dir, sub), { mode: 0o700 });
    let lastError;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      try {
        await this.#launch(this.#pickDisplay(attempt));
        return { display: this.#display };
      } catch (error) {
        lastError = error;
      }
    }
    await rm(this.#dir, { recursive: true, force: true });
    this.#dir = null;
    throw lastError ?? new DesktopError("DRIVER_FAILED", "Xvfb did not start.");
  }

  #pickDisplay(attempt) {
    const base = 90 + (process.pid % 400) + attempt * 7;
    for (let n = base; n < base + 200; n += 1) {
      if (!existsSync(`/tmp/.X${n}-lock`) && !existsSync(`/tmp/.X11-unix/X${n}`)) return n;
    }
    return base;
  }

  async #launch(number) {
    const display = `:${number}`;
    const args = [display, "-displayfd", "3", "-screen", "0", this.#screen, "-fbdir", join(this.#dir, "fb"), "-nolisten", "tcp", "-noreset"];
    if (this.#tools.xauth) {
      this.#authFile = join(this.#dir, "Xauthority");
      await run(this.#tools.xauth, ["-f", this.#authFile, "add", display, "MIT-MAGIC-COOKIE-1", randomBytes(16).toString("hex")]);
      args.push("-auth", this.#authFile);
    }
    const child = spawn(this.#tools.xvfb, args, { stdio: ["ignore", "ignore", "pipe", "pipe"], env: { PATH: process.env.PATH ?? "" } });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-4000); });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new DesktopError("DRIVER_FAILED", "Xvfb did not become ready in time.")); }, this.#startTimeoutMs);
      child.stdio[3].once("data", () => { clearTimeout(timer); resolve(); });
      child.once("exit", (code) => {
        clearTimeout(timer);
        const detail = stderr.split("\n").filter((line) => line && !/xkbcomp|keysym|Warning|^>|Errors from/u.test(line)).join(" ").slice(0, 200);
        reject(new DesktopError("DRIVER_FAILED", `Xvfb exited (${code}): ${detail}`));
      });
      child.once("error", (error) => { clearTimeout(timer); reject(new DesktopError("DRIVER_FAILED", error.message)); });
    });
    this.#process = child;
    this.#display = display;
  }

  async stop() {
    const child = this.#process;
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), 3000);
      await exited;
      clearTimeout(timer);
    }
    this.#process = null;
    this.#display = null;
    if (this.#dir) await rm(this.#dir, { recursive: true, force: true });
    this.#dir = null;
    this.#authFile = null;
  }
}

/**
 * A companion-interface driver for a running XvfbDisplay.
 *
 * @param {object} options
 * @param {XvfbDisplay} options.display a started display
 * @param {Record<string, { command: string, args?: string[], env?: object }>} [options.apps]
 *   launch specs by app name; `launch(name)` runs only these
 */
export function createXvfbDriver({ display, apps = {} }) {
  if (!display?.running) throw new DesktopError("NO_DISPLAY", "Start the Xvfb display before creating its driver.");
  const tools = display.tools;
  const linux = createLinuxDriver({ env: display.env() });
  const launched = new Map(); // pid -> { app, child }
  const indicator = { state: "inactive", history: [] };
  const needXdotool = (op) => {
    if (!tools.xdotool) throw new DesktopError("UNSUPPORTED", `${op} needs xdotool, which is not installed.`, { blocked: "BLOCKED_BY_CAPABILITY", unblock: "Install xdotool in the virtual desktop image." });
  };
  const gate = (op, fn) => async (...args) => { needXdotool(op); return fn(...args); };

  return {
    platform: "linux-xvfb",
    display: display.display,
    indicator,
    capabilities() {
      const running = display.running;
      const xdotool = Boolean(tools.xdotool);
      const reasons = {};
      if (!running) reasons.screenshot = "the virtual display is not running";
      if (!xdotool) {
        reasons.input = "xdotool not found; pointer and keyboard input are unsupported";
        reasons.windows = "xdotool not found; windows cannot be listed, inspected or focused";
      }
      reasons.accessibility = "X11 exposes no accessibility tree here (no AT-SPI bridge); element refs are unavailable";
      if (!tools.xclip) reasons.clipboard = "xclip not found";
      return {
        driver: "xvfb",
        screenshot: running,
        screenshotMethod: tools.import ? "imagemagick-import" : "xvfb-fbdir",
        accessibility: false,
        windows: running && xdotool,
        input: running && xdotool,
        launch: running,
        clipboard: running && Boolean(tools.xclip),
        indicator: true,
        accessControl: tools.xauth ? "mit-magic-cookie" : "none (xauth missing; local socket only)",
        reasons,
      };
    },
    /**
     * Nobody looks at an Xvfb display directly, so the indicator is state
     * the hosting UI renders (the controller's onIndicator carries it there).
     */
    renderIndicator(event) {
      indicator.state = event.state;
      indicator.history.push({ state: event.state, sessionId: event.sessionId });
    },
    async screenshot() {
      if (!display.running) throw new DesktopError("UNSUPPORTED", "The virtual display is not running.");
      if (tools.import) return linux.screenshot();
      const png = xwdToPng(await readFile(display.framebufferPath));
      if (!png) throw new DesktopError("DRIVER_FAILED", "The Xvfb framebuffer was not a readable TrueColor XWD image.");
      return png;
    },
    windows: gate("Listing windows", () => linux.windows()),
    activeWindow: gate("Finding the active window", () => linux.activeWindow()),
    inspect: gate("Inspecting windows", () => linux.inspect()),
    focus: gate("Focusing a window", (title) => linux.focus(title)),
    click: gate("Clicking", (action) => linux.click(action)),
    move: gate("Moving the pointer", (action) => linux.move(action)),
    type: gate("Typing", (text) => linux.type(text)),
    key: gate("Pressing keys", (keys) => linux.key(keys)),
    scroll: gate("Scrolling", (action) => linux.scroll(action)),
    clipboardRead: () => linux.clipboardRead(),
    clipboardWrite: (text) => linux.clipboardWrite(text),
    async launch(app) {
      if (!display.running) throw new DesktopError("UNSUPPORTED", "The virtual display is not running.");
      const spec = apps[String(app).toLowerCase()];
      if (!spec || typeof spec.command !== "string") throw new DesktopError("APP_NOT_ALLOWLISTED", `No launch command is configured for '${app}'.`);
      const child = spawn(spec.command, spec.args ?? [], { cwd: display.env().HOME, env: display.env(spec.env ?? {}), stdio: "ignore", detached: true });
      await new Promise((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", (error) => reject(new DesktopError("APP_NOT_FOUND", `Could not launch '${app}': ${error.message}`)));
      });
      launched.set(child.pid, { app, child });
      child.once("exit", () => launched.delete(child.pid));
      return { app, pid: child.pid, display: display.display };
    },
    /** Kills every app launched into the display (their whole process groups). */
    async closeApps() {
      for (const { child } of launched.values()) {
        try { process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ }
      }
      launched.clear();
    },
  };
}
