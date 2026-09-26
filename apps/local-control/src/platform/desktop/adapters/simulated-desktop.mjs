import { DesktopError } from "../errors.mjs";
import { encodePng } from "../png.mjs";

/**
 * A deterministic in-memory desktop that implements the companion's desktop
 * driver interface (apps/windows-companion/src/desktop/drivers/*):
 *
 *   screenshot() -> PNG Buffer, windows(), activeWindow(), inspect(),
 *   focus(title), click({x,y,button,double}), move({x,y}), type(text),
 *   key(keys), scroll({dx,dy}), launch(app), clipboardRead(), clipboardWrite(text)
 *
 * plus the two optional extensions the safety layer uses:
 * `capabilities()` and `renderIndicator(event)`.
 *
 * Windows have accessible elements with screen bounds, z-order and focus,
 * and can be moved (by "the user", via `moveWindow`), which is what the
 * control loop's stale-element recovery is tested against. `type` honours an
 * abort signal between characters so an emergency stop can cut typing off.
 */

const INDICATOR_STATES = new Set(["active", "paused", "inactive"]);

function inside(rect, x, y) {
  return x >= rect.x && y >= rect.y && x < rect.x + rect.width && y < rect.y + rect.height;
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new DesktopError("ABORTED", "Aborted."));
    const onAbort = () => { clearTimeout(timer); reject(signal.reason ?? new DesktopError("ABORTED", "Aborted.")); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Sample apps. Each factory returns `{ title, width, height, elements, onActivate?, onKey? }`;
 * element positions are relative to the window.
 */
export const SAMPLE_APPS = Object.freeze({
  notes: () => ({
    title: "Notes - Untitled",
    width: 400,
    height: 300,
    elements: [
      { id: "title", role: "Edit", name: "Title", x: 10, y: 10, width: 380, height: 24, value: "" },
      { id: "body", role: "Edit", name: "Body", x: 10, y: 44, width: 380, height: 180, value: "" },
      { id: "save", role: "Button", name: "Save", x: 10, y: 240, width: 80, height: 30 },
      { id: "status", role: "Text", name: "Status", x: 100, y: 240, width: 290, height: 30, value: "" },
    ],
    onActivate(window, element, desktop) {
      if (element.id !== "save") return;
      const title = window.get("title").value || "Untitled";
      desktop.files.set(`notes/${title}.txt`, window.get("body").value);
      window.get("status").value = `Saved ${title}`;
      window.title = `Notes - ${title}`;
    },
    onKey(window, keys, desktop) {
      if (keys === "ctrl+s") this.onActivate(window, window.get("save"), desktop);
    },
  }),
  mail: () => ({
    title: "Mail - Compose",
    width: 420,
    height: 320,
    elements: [
      { id: "to", role: "Edit", name: "To", x: 10, y: 10, width: 400, height: 24, value: "" },
      { id: "message", role: "Edit", name: "Message", x: 10, y: 44, width: 400, height: 200, value: "" },
      { id: "send", role: "Button", name: "Send", x: 10, y: 260, width: 80, height: 30 },
    ],
    onActivate(window, element, desktop) {
      if (element.id === "send") desktop.outbox.push({ to: window.get("to").value, message: window.get("message").value });
    },
  }),
  terminal: () => ({
    title: "Terminal",
    width: 500,
    height: 300,
    elements: [{ id: "console", role: "Edit", name: "Console", x: 0, y: 0, width: 500, height: 300, value: "" }],
  }),
});

class SimWindow {
  constructor({ id, app, spec, x, y }) {
    this.id = id;
    this.app = app;
    this.spec = spec;
    this.title = spec.title;
    this.x = x;
    this.y = y;
    this.width = spec.width;
    this.height = spec.height;
    this.elements = spec.elements.map((element) => ({ ...element }));
    this.focusedElementId = null;
    this.scrollY = 0;
  }

  get(id) { return this.elements.find((element) => element.id === id); }
  get bounds() { return { x: this.x, y: this.y, width: this.width, height: this.height }; }
  absolute(element) { return { x: this.x + element.x, y: this.y + element.y, width: element.width, height: element.height }; }
}

export class SimulatedDesktop {
  platform = "simulated";
  #caps;

  constructor({ width = 1280, height = 800, apps = SAMPLE_APPS, charDelayMs = 0, capabilities = {} } = {}) {
    this.width = width;
    this.height = height;
    this.apps = apps;
    this.charDelayMs = charDelayMs;
    this.windows_ = []; // index 0 = bottom, last = top
    this.focusedWindowId = null;
    this.pointer = { x: 0, y: 0 };
    this.clipboard = "";
    this.files = new Map();
    this.outbox = [];
    this.indicator = { state: "inactive", history: [] };
    this.launched = [];
    this.nextWindow = 1;
    this.#caps = { screenshot: true, accessibility: true, windows: true, input: true, launch: true, indicator: true, ...capabilities };
  }

  // ---- safety-layer extensions ---------------------------------------------

  capabilities() {
    const reasons = {};
    for (const [key, value] of Object.entries(this.#caps)) if (!value) reasons[key] = "disabled in this simulated desktop";
    return { driver: "simulated", ...this.#caps, reasons };
  }

  renderIndicator(event) {
    if (!INDICATOR_STATES.has(event.state)) throw new DesktopError("INVALID_INDICATOR", `Unknown indicator state '${event.state}'.`);
    this.indicator.state = event.state;
    this.indicator.history.push({ state: event.state, sessionId: event.sessionId });
  }

  // ---- driver interface -----------------------------------------------------

  async screenshot() {
    const scale = 8;
    const w = Math.ceil(this.width / scale);
    const h = Math.ceil(this.height / scale);
    const rgb = Buffer.alloc(w * h * 3, 40);
    for (const window of this.windows_) {
      const shade = window.id === this.focusedWindowId ? 230 : 160;
      for (let py = Math.max(0, Math.floor(window.y / scale)); py < Math.min(h, Math.ceil((window.y + window.height) / scale)); py += 1) {
        for (let px = Math.max(0, Math.floor(window.x / scale)); px < Math.min(w, Math.ceil((window.x + window.width) / scale)); px += 1) {
          rgb.fill(shade, (py * w + px) * 3, (py * w + px) * 3 + 3);
        }
      }
    }
    return encodePng(w, h, rgb);
  }

  /** Top-most first, like a window manager's stacking list. */
  async windows() {
    return [...this.windows_].reverse().map((window) => ({ id: window.id, title: window.title, process: window.app, bounds: window.bounds }));
  }

  async activeWindow() {
    const window = this.#focused();
    return window ? { id: window.id, title: window.title, process: window.app } : { id: null, title: "" };
  }

  async inspect() {
    const window = this.#focused();
    if (!window) return { window: null, tree: [] };
    return {
      window: { id: window.id, title: window.title, process: window.app },
      geometry: window.bounds,
      tree: window.elements.map((element) => ({
        role: element.role,
        name: element.name,
        bounds: window.absolute(element),
        ...(element.value !== undefined && { value: element.value }),
        ...(window.focusedElementId === element.id && { focused: true }),
      })),
    };
  }

  async focus(title) {
    const window = [...this.windows_].reverse().find((item) => item.title.includes(title));
    if (!window) throw new DesktopError("WINDOW_NOT_FOUND", `No window titled like “${title}”.`);
    this.#raise(window);
    return { id: window.id, title: window.title };
  }

  async click({ x, y }) {
    this.pointer = { x, y };
    const window = this.#windowAt(x, y);
    if (!window) return;
    this.#raise(window);
    const element = [...window.elements].reverse().find((item) => inside(window.absolute(item), x, y));
    if (!element) return;
    if (element.role === "Edit" || element.role === "Button") window.focusedElementId = element.id;
    if (element.role === "Button") window.spec.onActivate?.(window, element, this);
  }

  async move({ x, y }) { this.pointer = { x, y }; }

  async type(text, { signal } = {}) {
    const window = this.#focused();
    const element = window?.get(window.focusedElementId);
    if (!element || element.role !== "Edit") throw new DesktopError("NO_TARGET", "No text field has keyboard focus.");
    for (const char of text) {
      if (signal?.aborted) throw signal.reason ?? new DesktopError("ABORTED", "Aborted.");
      if (this.charDelayMs > 0) await sleep(this.charDelayMs, signal);
      element.value += char;
    }
  }

  async key(keys) {
    const window = this.#focused();
    if (!window) throw new DesktopError("NO_TARGET", "No window has focus.");
    const element = window.get(window.focusedElementId);
    if (keys === "enter" && element?.role === "Button") window.spec.onActivate?.(window, element, this);
    else if (keys === "tab") {
      const focusable = window.elements.filter((item) => item.role === "Edit" || item.role === "Button");
      const next = focusable[(focusable.indexOf(element) + 1) % focusable.length];
      window.focusedElementId = next?.id ?? null;
    } else window.spec.onKey?.call(window.spec, window, keys, this);
  }

  async scroll({ dy = 0 }) {
    const window = this.#focused();
    if (window) window.scrollY = Math.max(0, window.scrollY + dy);
  }

  async launch(app) {
    const factory = this.apps[app.toLowerCase()];
    if (!factory) throw new DesktopError("APP_NOT_FOUND", `${app} could not be started.`);
    this.openWindow(app.toLowerCase());
    this.launched.push(app.toLowerCase());
  }

  async clipboardRead() { return this.clipboard; }
  async clipboardWrite(text) { this.clipboard = text; }

  // ---- world helpers (not part of the driver interface) ----------------------

  /** Opens an app window as the user would (not through Atlas). */
  openWindow(app) {
    const offset = (this.nextWindow - 1) * 40;
    const window = new SimWindow({ id: `w${this.nextWindow}`, app, spec: this.apps[app](), x: 100 + offset, y: 80 + offset });
    this.nextWindow += 1;
    this.windows_.push(window);
    this.focusedWindowId = window.id;
    return window;
  }

  /** Simulates the user moving a window. */
  moveWindow(windowId, x, y) {
    const window = this.#window(windowId);
    if (!window) throw new DesktopError("NO_TARGET", "No such window.");
    window.x = x;
    window.y = y;
  }

  windowByApp(app) { return this.windows_.find((window) => window.app === app) ?? null; }

  /** Clicks the centre of a named element the way a user would. */
  async userClick(windowId, elementName) {
    const window = this.#window(windowId);
    const element = window.elements.find((item) => item.name === elementName);
    const box = window.absolute(element);
    await this.click({ x: box.x + 2, y: box.y + 2 });
  }

  #window(id) { return this.windows_.find((window) => window.id === id) ?? null; }
  #focused() { return this.#window(this.focusedWindowId); }

  #windowAt(x, y) {
    for (let i = this.windows_.length - 1; i >= 0; i -= 1) if (inside(this.windows_[i].bounds, x, y)) return this.windows_[i];
    return null;
  }

  #raise(window) {
    this.windows_ = [...this.windows_.filter((item) => item !== window), window];
    this.focusedWindowId = window.id;
  }
}
