import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { DesktopSession, validateDesktopAction } from "../../../../windows-companion/src/desktop/index.mjs";
import { DesktopError, REFUSAL_CODES } from "./errors.mjs";
import { MAX_SESSION_TTL_MS } from "./safety-store.mjs";

/**
 * DesktopController: the adapter-independent safety layer over the
 * companion's desktop runtime.
 *
 * It does not drive anything itself. Every action is executed by the
 * companion's `DesktopSession` (apps/windows-companion/src/desktop/session.mjs)
 * over a companion-interface driver (Windows UIA, Linux X11, or the Xvfb /
 * simulated drivers in ./adapters), so the action vocabulary, the
 * deterministic risk rules and the digest-bound approvals for consequential
 * actions are exactly the companion's. What this layer adds, in order, on
 * every action:
 *
 *   1. emergency-stop latch            -> EMERGENCY_STOPPED
 *   2. session exists / is live        -> NO_SESSION, SESSION_PAUSED, SESSION_ENDED ...
 *   3. session TTL                      -> SESSION_EXPIRED (session closed, indicator off)
 *   4. device still enrolled            -> DEVICE_REVOKED (its sessions closed)
 *   5. driver capability                -> UNSUPPORTED (reported honestly, never faked)
 *   6. target resolution + scope        -> SCOPE_DENIED, APP_NOT_ALLOWLISTED, STALE_ELEMENT
 *   7. per-action policy hook           -> POLICY_DENIED, APPROVAL_REQUIRED
 *   8. the companion's DesktopSession: validation, risk rules, digest-bound
 *      approval for consequential actions, before/after evidence screenshots
 *   9. audit of every attempt (typed text redacted; screenshots by digest)
 *
 * Steps 8's driver calls run under an abort signal that pause, stop and the
 * emergency stop fire, carried to the driver through AsyncLocalStorage so the
 * companion's session code needs no changes.
 *
 * Accessibility element refs are the preferred way to point at things: the
 * controller assigns stable refs to the nodes of the focused window's
 * accessibility tree and refuses a ref whose element has moved since it was
 * observed (STALE_ELEMENT) rather than clicking wherever it used to be.
 * Coordinate clicks are accepted as a fallback and flagged in the result and
 * audit trail.
 *
 * Nothing is installed: no service, autostart entry or persistent agent.
 * Control exists only inside an owner-approved, short-lived session.
 */

/** The companion driver interface (see apps/windows-companion/src/desktop/drivers). */
export const DRIVER_METHODS = Object.freeze(["screenshot", "windows", "activeWindow", "inspect", "focus", "click", "move", "type", "key", "scroll", "launch"]);

const CAPABILITY_FOR = Object.freeze({
  desktop_observe: "windows",
  desktop_screenshot: "screenshot",
  focus_window: "windows",
  desktop_click: "input",
  desktop_move: "input",
  desktop_type: "input",
  desktop_key: "input",
  desktop_scroll: "input",
  launch_app: "launch",
  clipboard_read: "clipboard",
  clipboard_write: "clipboard",
});

/** Actions that act inside a window and therefore need an in-scope target window. */
const WINDOW_SCOPED = new Set(["focus_window", "desktop_click", "desktop_type", "desktop_key", "desktop_scroll"]);

const DEFAULT_MAX_READ_BYTES = 1024 * 1024;

export function assertDriver(driver) {
  const missing = DRIVER_METHODS.filter((name) => typeof driver?.[name] !== "function");
  if (missing.length) throw new DesktopError("INVALID_DRIVER", `Desktop driver is missing: ${missing.join(", ")}.`);
  return driver;
}

/** What goes into the audit trail (and the policy hook) for an action. Typed text never does. */
export function redactParams(params = {}) {
  const out = {};
  for (const [key, value] of Object.entries(params ?? {})) {
    if (key === "text") out.text = `[REDACTED ${typeof value === "string" ? value.length : 0} chars]`;
    else if (key === "target" && value && typeof value === "object") out.target = { ref: value.ref, name: value.name, role: value.role, app: value.app };
    else if (value === null || ["string", "number", "boolean"].includes(typeof value)) out[key] = typeof value === "string" ? value.slice(0, 300) : value;
  }
  return out;
}

/** Same binding the daemon uses for desktop approvals (main.mjs buildDesktopSession). */
export function desktopActionDigest(action) {
  return createHash("sha256").update(JSON.stringify(action)).digest("hex");
}

function inside(rect, x, y) {
  return rect && x >= rect.x && y >= rect.y && x < rect.x + rect.width && y < rect.y + rect.height;
}

function sameBounds(a, b) {
  return a && b && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

function abortError(signal) {
  const reason = signal?.reason;
  if (reason instanceof DesktopError) return reason;
  return new DesktopError("ABORTED", "The action was aborted.");
}

function withinRoot(root, candidate) {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel) && !rel.split(sep).includes(".."));
}

function flattenTree(nodes, windowId, path = "") {
  const out = [];
  (nodes ?? []).forEach((node, index) => {
    const here = `${path}/${index}`;
    out.push({ node, path: here, windowId });
    if (Array.isArray(node.children)) out.push(...flattenTree(node.children, windowId, here));
  });
  return out;
}

function refFor(windowId, path, node) {
  return `el_${createHash("sha256").update(`${windowId}|${path}|${node.role ?? ""}|${node.name ?? ""}`).digest("hex").slice(0, 20)}`;
}

export class DesktopController {
  #driver;
  #store;
  #deviceId;
  #allowedApps;
  #readableRoots;
  #policyCheck;
  #onIndicator;
  #approve;
  #evidenceDir;
  #maxActions;
  #maxSessionTtlMs;
  #maxReadBytes;
  #als = new AsyncLocalStorage();
  /** sessionId -> { desktop: DesktopSession, refs: Map, inFlight: Set<AbortController> } */
  #runtimes = new Map();

  /**
   * @param {object} options
   * @param {object} options.driver a companion-interface desktop driver
   * @param {import("./safety-store.mjs").DesktopSafetyStore} options.store
   * @param {string} options.deviceId the enrolled device this controller operates
   * @param {string[]} [options.allowedApps] apps that may be launched (a session's scope narrows it further)
   * @param {(request) => Promise<void>} [options.approve] digest-bound approval for actions the
   *   companion's rules mark "ask"; receives `{ action, risk, window, sessionId, digest }`, resolves
   *   when an approval for that exact digest was granted (and consumed), throws otherwise.
   *   Default: fail closed with APPROVAL_REQUIRED.
   */
  constructor({
    driver,
    store,
    deviceId,
    allowedApps = [],
    readableRoots = [],
    policyCheck = null,
    onIndicator = null,
    approve = null,
    evidenceDir = null,
    maxActionsPerSession = 500,
    maxSessionTtlMs = MAX_SESSION_TTL_MS,
    maxReadBytes = DEFAULT_MAX_READ_BYTES,
  }) {
    this.#driver = assertDriver(driver);
    if (!store) throw new DesktopError("MISCONFIGURED", "The desktop controller needs a safety store.");
    if (!store.getDevice(deviceId)) throw new DesktopError("NO_DEVICE", "The desktop controller must be bound to a registered device.");
    this.#store = store;
    this.#deviceId = deviceId;
    this.#allowedApps = (Array.isArray(allowedApps) ? allowedApps : Object.keys(allowedApps)).map((name) => String(name).toLowerCase());
    this.#readableRoots = readableRoots.map((root) => resolve(root));
    this.#policyCheck = policyCheck;
    this.#onIndicator = onIndicator;
    this.#approve = approve ?? (async ({ risk }) => {
      throw new DesktopError("APPROVAL_REQUIRED", `This desktop action needs the owner's approval: ${risk.reason}.`);
    });
    this.#evidenceDir = evidenceDir;
    this.#maxActions = maxActionsPerSession;
    this.#maxSessionTtlMs = maxSessionTtlMs;
    this.#maxReadBytes = maxReadBytes;
  }

  get deviceId() { return this.#deviceId; }
  get store() { return this.#store; }

  capabilities() {
    const reported = typeof this.#driver.capabilities === "function" ? this.#driver.capabilities() : {};
    return { driver: reported.driver ?? this.#driver.platform ?? "unknown", ...reported, reasons: reported.reasons ?? {} };
  }

  allowlistedApps() { return [...this.#allowedApps]; }

  // -------------------------------------------------------------------------
  // Sessions
  // -------------------------------------------------------------------------

  /** Opens a session. There is no path to a session without an owner-approved, unused approval id. */
  async createSession({ approvalId, requestedBy = undefined } = {}) {
    const audit = { action: "session.create", params: { approvalId: approvalId ?? null }, actor: requestedBy ?? null, deviceId: this.#deviceId };
    try {
      if (typeof approvalId !== "string" || !approvalId) {
        throw new DesktopError("APPROVAL_REQUIRED", "A control session requires an approval id; there is no unattended access.");
      }
      if (typeof this.#driver.renderIndicator !== "function" && typeof this.#onIndicator !== "function") {
        throw new DesktopError("INDICATOR_UNAVAILABLE", "No active-control indicator can be shown for this driver, so control is refused.");
      }
      this.#assertArmed();
      const session = this.#store.openSession({ approvalId, deviceId: this.#deviceId, requestedBy, maxSessionTtlMs: this.#maxSessionTtlMs });
      this.#store.appendAudit({ ...audit, sessionId: session.id, outcome: "succeeded" });
      await this.#indicate("active", session, "session started");
      return session;
    } catch (error) {
      this.#store.appendAudit({ ...audit, outcome: "refused", errorCode: error.code ?? "ERROR", message: error.message });
      throw error;
    }
  }

  getSession(sessionId) { return this.#store.getSession(sessionId); }

  async pause(sessionId, { by = null } = {}) {
    const session = this.#liveSession(sessionId);
    const updated = this.#store.setSessionStatus(session.id, "paused");
    this.#abortSession(session.id, new DesktopError("SESSION_PAUSED", "The session was paused."));
    this.#store.appendAudit({ sessionId, deviceId: this.#deviceId, actor: by, action: "session.pause", outcome: "succeeded" });
    await this.#indicate("paused", updated, "session paused");
    return updated;
  }

  async resume(sessionId, { by = null } = {}) {
    this.#assertArmed();
    const session = this.#store.getSession(sessionId);
    if (!session || session.deviceId !== this.#deviceId || session.status !== "paused") throw new DesktopError("INVALID_STATE", "Only a paused session can be resumed.");
    this.#checkExpiry(session);
    this.#checkDevice(session);
    const updated = this.#store.setSessionStatus(session.id, "active");
    this.#store.appendAudit({ sessionId, deviceId: this.#deviceId, actor: by, action: "session.resume", outcome: "succeeded" });
    await this.#indicate("active", updated, "session resumed");
    return updated;
  }

  async stop(sessionId, { by = null, reason = "stopped" } = {}) {
    const session = this.#store.getSession(sessionId);
    if (!session || session.deviceId !== this.#deviceId) throw new DesktopError("NO_SESSION", "No such session.");
    if (!["active", "paused"].includes(session.status)) return session;
    return this.#close(session, "ended", reason, { actor: by, code: "SESSION_ENDED" });
  }

  // -------------------------------------------------------------------------
  // Emergency stop
  // -------------------------------------------------------------------------

  isEmergencyStopped() { return this.#store.emergencyState().stopped === true; }

  /**
   * Latches first (synchronously, durably), then aborts every in-flight
   * action, closes every live session on this device, and refuses everything
   * until `rearm` is called explicitly.
   */
  async emergencyStop({ by = null, reason = "emergency stop" } = {}) {
    const at = this.#store.now().toISOString();
    this.#store.setEmergencyState({ stopped: true, at, by, reason: String(reason).slice(0, 500) });
    const stopError = new DesktopError("EMERGENCY_STOPPED", "Emergency stop is engaged; all desktop control is halted.");
    for (const sessionId of this.#runtimes.keys()) this.#abortSession(sessionId, stopError);
    const live = this.#store.listSessions({ deviceId: this.#deviceId, live: true });
    for (const session of live) await this.#close(session, "emergency_stopped", reason, { actor: by, code: "EMERGENCY_STOPPED", audit: false });
    this.#store.appendAudit({ deviceId: this.#deviceId, actor: by, action: "emergency.stop", params: { sessionsClosed: live.length }, outcome: "succeeded", message: reason });
    return { stopped: true, at, sessionsClosed: live.map((session) => session.id) };
  }

  /** Re-arming needs a named person and the literal confirmation "REARM". Old sessions stay closed. */
  rearm({ by, confirm } = {}) {
    if (typeof by !== "string" || !by || confirm !== "REARM") {
      throw new DesktopError("REARM_REQUIRES_CONFIRMATION", "Re-arming needs `by` and `confirm: \"REARM\"`.");
    }
    const previous = this.#store.emergencyState();
    this.#store.setEmergencyState({ stopped: false, rearmedAt: this.#store.now().toISOString(), rearmedBy: by, previous });
    this.#store.appendAudit({ deviceId: this.#deviceId, actor: by, action: "emergency.rearm", outcome: "succeeded" });
    return { stopped: false };
  }

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  /**
   * Runs one action in the companion's vocabulary (`desktop_click`,
   * `desktop_type`, `launch_app`, ...) through the whole pipeline. This is
   * also what `guardedSession()` exposes to the daemon's desktop tools.
   */
  async perform(sessionId, proposed, { signal } = {}) {
    return this.#perform(sessionId, proposed, { signal, params: proposed });
  }

  /**
   * A `{ perform, observe }` object with the companion DesktopSession's shape,
   * bound to one approved session, so the daemon's existing desktop tools
   * (`registerDesktopTools(registry, { session })`) run behind this layer.
   */
  guardedSession(sessionId) {
    return {
      perform: (action) => this.perform(sessionId, action),
      observe: async () => (await this.observe(sessionId)),
    };
  }

  /** Windows, focused window, and its accessibility tree with element refs; optionally a screenshot by digest. */
  async observe(sessionId, { screenshot = false } = {}, { signal } = {}) {
    const { result } = await this.#perform(sessionId, { type: "desktop_observe" }, { signal, params: {} });
    const runtime = this.#runtimes.get(sessionId);
    const focused = result.focused ? await this.#windowInfo(result.focused, result.windows) : null;
    const elements = this.#annotate(runtime, result.tree, focused);
    let screenshotDigest = null;
    if (screenshot && this.capabilities().screenshot !== false) screenshotDigest = (await this.screenshot(sessionId, {}, { signal })).digest;
    return { windows: result.windows, focused, elements, geometry: result.geometry ?? null, screenshotDigest };
  }

  async screenshot(sessionId, _params = {}, { signal } = {}) {
    const { result } = await this.#perform(sessionId, { type: "desktop_screenshot" }, { signal, params: {} });
    const stored = result?.digest ? this.#store.getScreenshot(result.digest) : null;
    return { digest: result?.digest ?? null, bytes: result?.bytes ?? null, mediaType: stored?.mediaType ?? null, width: stored?.width ?? null, height: stored?.height ?? null };
  }

  async listWindows(sessionId, _params = {}, { signal } = {}) {
    return (await this.observe(sessionId, {}, { signal })).windows;
  }

  async focusWindow(sessionId, { windowId, title }, { signal } = {}) {
    return this.#perform(sessionId, null, {
      signal,
      kind: "focus_window",
      params: { windowId, title },
      prepare: async () => {
        const windows = await this.#driver.windows();
        const window = windowId ? windows.find((item) => item.id === windowId) : windows.find((item) => item.title.includes(title ?? "\u0000"));
        if (!window) throw new DesktopError("NO_TARGET", "No such window.");
        return { action: { type: "focus_window", title: window.title }, window: await this.#windowInfo(window, windows) };
      },
    });
  }

  /** Click by element ref (preferred) or at coordinates (flagged fallback). */
  async click(sessionId, params = {}, { signal } = {}) {
    const { target, x, y, button = "left", double = false } = params;
    const byRef = typeof target?.ref === "string";
    if (!byRef && !(Number.isInteger(x) && Number.isInteger(y))) throw new DesktopError("INVALID_ACTION", "click needs target.ref or integer x and y.");
    return this.#perform(sessionId, null, {
      signal,
      kind: "desktop_click",
      params: { target, x, y, button },
      coordinateFallback: !byRef,
      prepare: async (runtime) => {
        if (byRef) {
          const point = await this.#resolveRef(runtime, target.ref);
          return { action: { type: "desktop_click", x: point.x, y: point.y, button, double }, window: point.window };
        }
        return { action: { type: "desktop_click", x, y, button, double }, window: await this.#windowAt(x, y) };
      },
    });
  }

  async move(sessionId, { x, y }, { signal } = {}) {
    return this.#perform(sessionId, { type: "desktop_move", x, y }, { signal, params: { x, y } });
  }

  /** Types into target.ref when given (clicking it first), else into the focused window. */
  async typeText(sessionId, { text, target } = {}, { signal } = {}) {
    if (typeof target?.ref === "string") await this.click(sessionId, { target }, { signal });
    return this.#perform(sessionId, { type: "desktop_type", text }, { signal, params: { text, target } });
  }

  async keyPress(sessionId, { key, target } = {}, { signal } = {}) {
    if (typeof target?.ref === "string") await this.click(sessionId, { target }, { signal });
    return this.#perform(sessionId, { type: "desktop_key", keys: key }, { signal, params: { key, target } });
  }

  async scroll(sessionId, { dx = 0, dy = 0 } = {}, { signal } = {}) {
    return this.#perform(sessionId, { type: "desktop_scroll", dx, dy }, { signal, params: { dx, dy } });
  }

  /** Only apps on the controller's allowlist AND in the session's approved scope. */
  async launchApp(sessionId, { app }, { signal } = {}) {
    return this.#perform(sessionId, { type: "launch_app", app }, { signal, params: { app } });
  }

  /** Reads a file under a permitted root (symlinks resolved). Content is returned, never audited. */
  async readFile(sessionId, { path }, { signal } = {}) {
    return this.#perform(sessionId, null, {
      signal,
      params: { path },
      local: async () => {
        if (typeof path !== "string" || !path) throw new DesktopError("INVALID_ACTION", "readFile needs a path.");
        let real;
        try { real = await realpath(resolve(path)); } catch { throw new DesktopError("PATH_NOT_PERMITTED", "The path does not exist or is not readable."); }
        const roots = await Promise.all(this.#readableRoots.map((root) => realpath(root).catch(() => null)));
        if (!roots.some((root) => root && withinRoot(root, real))) throw new DesktopError("PATH_NOT_PERMITTED", "The path is outside the permitted directories.");
        const info = await stat(real);
        if (!info.isFile()) throw new DesktopError("PATH_NOT_PERMITTED", "Only regular files can be read.");
        if (info.size > this.#maxReadBytes) throw new DesktopError("FILE_TOO_LARGE", `The file is larger than ${this.#maxReadBytes} bytes.`);
        const bytes = await readFile(real);
        return { path: real, bytes: bytes.length, digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`, content: bytes.toString("utf8") };
      },
    });
  }

  audit({ sessionId } = {}) {
    return this.#store.listAudit({ sessionId, deviceId: sessionId ? undefined : this.#deviceId });
  }

  getScreenshot(digest) { return this.#store.getScreenshot(digest); }

  // -------------------------------------------------------------------------
  // Pipeline
  // -------------------------------------------------------------------------

  async #perform(sessionId, proposed, { signal: callerSignal, params = {}, prepare = null, local = null, coordinateFallback = false, kind: kindHint = null }) {
    const kind = proposed?.type ?? kindHint ?? (local ? "read_file" : "action");
    const audit = { sessionId: sessionId ?? null, deviceId: this.#deviceId, action: kind, params: redactParams(params), coordinateFallback };
    let session;
    let runtime;
    let action = proposed;
    let window = null;
    try {
      this.#assertArmed();
      session = this.#liveSession(sessionId);
      audit.actor = session.requestedBy;
      this.#checkExpiry(session);
      this.#checkDevice(session);
      runtime = this.#runtime(session.id);

      if (!local) {
        if (prepare) ({ action, window } = await prepare(runtime));
        action = validateDesktopAction(action);
        audit.action = action.type;
        const needed = CAPABILITY_FOR[action.type];
        const caps = this.capabilities();
        if (needed && caps[needed] === false) {
          throw new DesktopError("UNSUPPORTED", `This desktop driver cannot ${action.type}: ${caps.reasons?.[needed] ?? "capability not available"}.`);
        }
        if (action.type === "launch_app") {
          const app = action.app.toLowerCase();
          if (!this.#allowedApps.includes(app)) throw new DesktopError("APP_NOT_ALLOWLISTED", `'${action.app}' is not an allowlisted app.`);
          if (!session.scope.allowedApps.map((a) => a.toLowerCase()).includes(app)) throw new DesktopError("SCOPE_DENIED", `'${action.app}' is outside this session's approved scope.`);
        }
        if (WINDOW_SCOPED.has(action.type)) {
          window ??= await this.#windowInfo(await this.#driver.activeWindow());
          if (!window?.id) throw new DesktopError("NO_TARGET", `There is no window to ${action.type} into.`);
          if (!this.#inScope(session.scope, window)) {
            throw new DesktopError("SCOPE_DENIED", `${action.type} into “${window.title || window.app || "unknown window"}” is outside this session's approved apps/windows.`);
          }
        }
      }

      if (this.#policyCheck) {
        const verdict = await this.#policyCheck({
          sessionId: session.id, deviceId: this.#deviceId, action: action?.type ?? kind, params: redactParams({ ...params, ...(action ?? {}) }), window, coordinateFallback, scope: session.scope,
        });
        const effect = verdict?.effect ?? "deny";
        if (effect === "require_approval") throw new DesktopError("APPROVAL_REQUIRED", verdict.reason ?? "This action requires a fresh approval.");
        if (effect !== "allow") throw new DesktopError("POLICY_DENIED", verdict?.reason ?? "Denied by policy.");
      }
    } catch (error) {
      this.#store.appendAudit({ ...audit, outcome: "refused", errorCode: error.code ?? "ERROR", message: error.message });
      throw error;
    }

    const controller = new AbortController();
    const onCallerAbort = () => controller.abort(new DesktopError("ABORTED", "The caller aborted the action."));
    if (callerSignal?.aborted) onCallerAbort();
    callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
    runtime.inFlight.add(controller);
    const aborted = new Promise((_, reject) => {
      const fire = () => reject(abortError(controller.signal));
      if (controller.signal.aborted) fire();
      else controller.signal.addEventListener("abort", fire, { once: true });
    });
    aborted.catch(() => {});

    const context = { signal: controller.signal, shots: [] };
    try {
      const work = this.#als.run(context, () => (local ? local() : runtime.desktop.perform(action)));
      // The race means a driver that ignores its signal is still cut off from the caller.
      const outcome = await Promise.race([work, aborted]);
      if (controller.signal.aborted) throw abortError(controller.signal);
      const evidence = outcome?.evidence ?? [];
      this.#store.appendAudit({
        ...audit,
        outcome: "succeeded",
        screenshotDigest: evidence.at(-1)?.digest ?? outcome?.result?.digest ?? null,
        message: [outcome?.risk?.reason, outcome?.risk?.decision === "ask" ? "approved" : null, window ? `window “${window.title}”` : null].filter(Boolean).join("; ") || null,
      });
      if (local) return outcome;
      return { ...outcome, action: redactParams(outcome.action), coordinateFallback };
    } catch (error) {
      const wasAborted = controller.signal.aborted;
      const failure = wasAborted ? abortError(controller.signal)
        : error instanceof DesktopError || typeof error?.code === "string" ? error
          : new DesktopError("DRIVER_FAILED", String(error?.message ?? error).split("\n")[0].slice(0, 300));
      const outcome = wasAborted ? "aborted" : REFUSAL_CODES.has(failure.code) ? "refused" : "failed";
      this.#store.appendAudit({ ...audit, outcome, errorCode: failure.code ?? "ERROR", message: failure.message });
      throw failure;
    } finally {
      runtime.inFlight.delete(controller);
      callerSignal?.removeEventListener("abort", onCallerAbort);
    }
  }

  /** One companion DesktopSession per approved control session, over a signal-carrying, screenshot-archiving driver. */
  #runtime(sessionId) {
    let runtime = this.#runtimes.get(sessionId);
    if (runtime) return runtime;
    const als = this.#als;
    const store = this.#store;
    const driver = this.#driver;
    const wrapped = { platform: driver.platform };
    for (const name of [...DRIVER_METHODS, "clipboardRead", "clipboardWrite"]) {
      if (typeof driver[name] !== "function") continue;
      wrapped[name] = async (...args) => {
        const context = als.getStore();
        if (context?.signal?.aborted) throw abortError(context.signal);
        const value = await driver[name](...args, { signal: context?.signal });
        if (name === "screenshot" && Buffer.isBuffer(value)) {
          const size = value.readUInt32BE(0) === 0x89504e47 ? { width: value.readUInt32BE(16), height: value.readUInt32BE(20) } : {};
          context?.shots.push(store.putScreenshot({ bytes: value, mediaType: size.width ? "image/png" : "application/octet-stream", ...size }));
        }
        return value;
      };
    }
    runtime = {
      refs: new Map(),
      inFlight: new Set(),
      desktop: new DesktopSession({
        driver: wrapped,
        appAllowlist: this.#allowedApps,
        evidenceDir: this.#evidenceDir,
        maxActions: this.#maxActions,
        isActive: () => {
          const context = als.getStore();
          if (context?.signal?.aborted) throw abortError(context.signal);
        },
        approve: async ({ action, risk, window }) => this.#approve({ action, risk, window, sessionId, digest: desktopActionDigest(action) }),
      }),
    };
    this.#runtimes.set(sessionId, runtime);
    return runtime;
  }

  async #windowInfo(window, windows = null) {
    if (!window) return null;
    let app = window.process ?? window.app ?? null;
    let bounds = window.bounds ?? null;
    if ((!app || !bounds) && window.id) {
      const list = windows ?? await this.#driver.windows().catch(() => []);
      const match = list.find((item) => item.id === window.id);
      app ??= match?.process ?? match?.app ?? null;
      bounds ??= match?.bounds ?? null;
    }
    return { id: window.id ?? null, title: window.title ?? "", app: app ? String(app).toLowerCase() : null, bounds };
  }

  async #windowAt(x, y) {
    const windows = await this.#driver.windows();
    const hit = windows.find((window) => inside(window.bounds, x, y));
    if (hit) return this.#windowInfo(hit, windows);
    if (windows.some((window) => window.bounds)) throw new DesktopError("NO_TARGET", `Nothing is at (${x}, ${y}).`);
    // Driver without window geometry: the click lands in the active window as far as we can tell.
    return this.#windowInfo(await this.#driver.activeWindow(), windows);
  }

  #inScope(scope, window) {
    const app = window.app?.toLowerCase();
    if (app && scope.allowedApps.some((allowed) => allowed.toLowerCase() === app)) return true;
    return scope.allowedWindows.some((fragment) => (window.title ?? "").includes(fragment));
  }

  #annotate(runtime, tree, focused) {
    if (!focused?.id) return [];
    return flattenTree(tree, focused.id).map(({ node, path }) => {
      const ref = refFor(focused.id, path, node);
      const element = {
        ref, role: node.role ?? null, name: node.name ?? "", bounds: node.bounds ?? null,
        ...(node.value !== undefined && { value: node.value }), ...(node.focused && { focused: true }),
        windowId: focused.id, windowTitle: focused.title, app: focused.app,
      };
      runtime.refs.set(ref, element);
      return element;
    });
  }

  /** Resolves a ref against a fresh look at the screen; refuses it if the element moved or vanished. */
  async #resolveRef(runtime, ref) {
    const known = runtime.refs.get(ref);
    if (!known) throw new DesktopError("ELEMENT_NOT_FOUND", "Unknown element ref; observe first.");
    const inspected = await this.#driver.inspect();
    const focusedId = inspected.window?.id ?? null;
    const now = focusedId === known.windowId
      ? flattenTree(inspected.tree, focusedId).find(({ node, path }) => refFor(focusedId, path, node) === ref)
      : null;
    if (!now) throw new DesktopError("ELEMENT_NOT_FOUND", "The element is no longer on screen in its window.");
    if (!now.node.bounds) throw new DesktopError("UNSUPPORTED", "The element has no screen bounds to act on.");
    if (!sameBounds(now.node.bounds, known.bounds)) throw new DesktopError("STALE_ELEMENT", "The element moved since it was observed; observe again.");
    const b = now.node.bounds;
    return {
      x: b.x + Math.floor(b.width / 2),
      y: b.y + Math.floor(b.height / 2),
      window: { id: known.windowId, title: inspected.window?.title ?? known.windowTitle, app: known.app },
    };
  }

  #assertArmed() {
    if (this.isEmergencyStopped()) throw new DesktopError("EMERGENCY_STOPPED", "Emergency stop is engaged; re-arm explicitly before any desktop control.");
  }

  #liveSession(sessionId) {
    const session = typeof sessionId === "string" ? this.#store.getSession(sessionId) : null;
    if (!session || session.deviceId !== this.#deviceId) throw new DesktopError("NO_SESSION", "No such control session on this device.");
    if (session.status === "active") return session;
    const codes = { paused: "SESSION_PAUSED", expired: "SESSION_EXPIRED", revoked: "SESSION_REVOKED", emergency_stopped: "EMERGENCY_STOPPED", ended: "SESSION_ENDED" };
    throw new DesktopError(codes[session.status] ?? "SESSION_ENDED", `The session is '${session.status}'.`);
  }

  #checkExpiry(session) {
    if (session.expiresAt > this.#store.now().toISOString()) return;
    this.#store.setSessionStatus(session.id, "expired", { reason: "ttl elapsed", ended: true });
    this.#abortSession(session.id, new DesktopError("SESSION_EXPIRED", "The session expired."));
    this.#indicate("inactive", { ...session, status: "expired" }, "session expired").catch(() => {});
    throw new DesktopError("SESSION_EXPIRED", "The control session has expired; request a new approval.");
  }

  #checkDevice(session) {
    const device = this.#store.getDevice(this.#deviceId);
    if (device?.status === "enrolled") return;
    this.#store.setSessionStatus(session.id, "revoked", { reason: "device not enrolled", ended: true });
    this.#abortSession(session.id, new DesktopError("DEVICE_REVOKED", "The device was revoked."));
    this.#indicate("inactive", { ...session, status: "revoked" }, "device revoked").catch(() => {});
    throw new DesktopError(device?.status === "revoked" ? "DEVICE_REVOKED" : "DEVICE_NOT_ENROLLED", `The device is '${device?.status ?? "unknown"}'.`);
  }

  #abortSession(sessionId, error) {
    for (const controller of this.#runtimes.get(sessionId)?.inFlight ?? []) controller.abort(error);
  }

  async #close(session, status, reason, { actor = null, code, audit = true }) {
    const updated = this.#store.setSessionStatus(session.id, status, { reason: String(reason).slice(0, 200), ended: true });
    this.#abortSession(session.id, new DesktopError(code, `The session was closed: ${reason}.`));
    if (audit) this.#store.appendAudit({ sessionId: session.id, deviceId: this.#deviceId, actor, action: "session.stop", outcome: "succeeded", message: reason });
    await this.#indicate("inactive", updated, reason);
    return updated;
  }

  /**
   * The visible "Atlas is controlling this computer" indicator: the driver
   * renders it on the controlled display (when it can) and the host callback
   * mirrors it in the control UI. If it cannot be shown when a session starts,
   * the session is closed: control without the indicator is not allowed.
   */
  async #indicate(state, session, reason) {
    const event = { state, sessionId: session.id, deviceId: this.#deviceId, scope: session.scope, reason, at: this.#store.now().toISOString() };
    try {
      if (typeof this.#driver.renderIndicator === "function") await this.#driver.renderIndicator(event);
      if (this.#onIndicator) await this.#onIndicator(event);
    } catch (error) {
      this.#store.appendAudit({ sessionId: session.id, deviceId: this.#deviceId, action: "indicator", params: { state }, outcome: "failed", errorCode: "INDICATOR_FAILED", message: error?.message });
      if (state === "active") {
        this.#store.setSessionStatus(session.id, "ended", { reason: "indicator could not be shown", ended: true });
        throw new DesktopError("INDICATOR_FAILED", "The active-control indicator could not be shown, so the session was closed.");
      }
    }
  }
}
