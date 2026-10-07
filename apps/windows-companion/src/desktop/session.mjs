import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { DesktopError, desktopRisk, validateDesktopAction } from "./actions.mjs";

/**
 * One desktop operating session: every proposed action is validated,
 * classified, approved when the rules say so, executed through the driver,
 * and recorded with evidence. The session owns the limits — a step budget and
 * cancellation — so a looping model cannot run past them.
 *
 * Evidence: input actions are bracketed by before/after screenshots, stored
 * locally (they may show private things) and reported by SHA-256 digest.
 */
export class DesktopSession {
  #driver;
  #approve;
  #isActive;
  #evidenceDir;
  #maxActions;
  #appAllowlist;
  #control;
  #log = [];

  /**
   * @param {object} options
   * @param {object} options.driver a desktop driver (see drivers/)
   * @param {(request: {action, risk}) => Promise<void>} options.approve resolves when approved, throws when refused
   * @param {() => Promise<void>|void} [options.isActive] throws when the task was cancelled
   * @param {string|null} [options.evidenceDir] where screenshots are written; null keeps digests only
   * @param {object|null} [options.control] the shared operator control (pause, take over, cancel, intent journal)
   */
  constructor({ driver, approve, isActive = () => {}, evidenceDir = null, maxActions = 60, appAllowlist, control = null } = {}) {
    if (!driver) throw new TypeError("driver is required.");
    if (typeof approve !== "function") throw new TypeError("approve is required.");
    this.#driver = driver;
    this.#approve = approve;
    this.#isActive = isActive;
    this.#evidenceDir = evidenceDir;
    this.#maxActions = maxActions;
    this.#appAllowlist = appAllowlist;
    this.#control = control;
  }

  get log() { return structuredClone(this.#log); }

  async #evidence(label) {
    const png = await this.#driver.screenshot();
    const digest = `sha256:${createHash("sha256").update(png).digest("hex")}`;
    let path = null;
    if (this.#evidenceDir) {
      await mkdir(this.#evidenceDir, { recursive: true });
      path = join(this.#evidenceDir, `${String(this.#log.length + 1).padStart(3, "0")}-${label}.png`);
      await writeFile(path, png);
    }
    return { digest, bytes: png.length, path, png };
  }

  /** What the planner sees: windows, the focused window, and its accessibility tree where the OS has one. */
  async observe() {
    this.#control?.guard({ kind: "read" });
    const [windows, inspected] = await Promise.all([this.#driver.windows(), this.#driver.inspect()]);
    return { windows: windows.slice(0, 40), focused: inspected.window, tree: inspected.tree ?? [], geometry: inspected.geometry ?? null };
  }

  /**
   * Validates, classifies, approves and performs one action.
   * @returns {Promise<{ action, risk, result, evidence }>}
   */
  async perform(proposed) {
    await this.#isActive();
    this.#control?.guard({ kind: "act" });
    if (this.#log.length >= this.#maxActions) {
      throw new DesktopError("STEP_LIMIT", `This task reached its ${this.#maxActions}-action safety limit.`, { blocked: "BLOCKED_BY_BUDGET", unblock: "Start a new task with a narrower goal, or raise the limit." });
    }
    const action = validateDesktopAction(proposed);
    const active = await this.#driver.activeWindow().catch(() => ({ title: "" }));
    const risk = desktopRisk(action, { activeWindowTitle: active.title, appAllowlist: this.#appAllowlist });
    const entry = { at: new Date().toISOString(), action: redactForLog(action), risk, window: active.title, outcome: "pending" };
    this.#log.push(entry);
    if (risk.decision === "deny") {
      entry.outcome = "denied";
      throw new DesktopError("ACTION_DENIED", `Refused: ${risk.reason}.`, { blocked: "BLOCKED_BY_POLICY", unblock: "Do this step yourself if it is really needed." });
    }
    let intentId = null;
    if (risk.decision === "ask") {
      this.#control?.setApprovalPending(true);
      try { await this.#approve({ action, risk, window: active.title }); }
      catch (error) { entry.outcome = "rejected"; throw error; }
      finally { this.#control?.setApprovalPending(false); }
      entry.approved = true;
    }
    await this.#isActive();
    // An approval can arrive after the owner paused or took over; it is not spent while they have control.
    this.#control?.guard({ kind: "act" });
    if (risk.decision === "ask" && this.#control) {
      intentId = this.#control.intent({ digest: createHash("sha256").update(JSON.stringify(action)).digest("hex"), summary: `${risk.reason}`, actionClass: risk.class });
    }
    const changes = !["read", "navigate"].includes(risk.class) || action.type === "focus_window";
    const before = changes ? await this.#evidence("before").catch(() => null) : null;
    let result;
    try {
      result = this.#control ? await this.#control.run(action.type, () => this.#execute(action)) : await this.#execute(action);
    } catch (error) {
      entry.outcome = "failed";
      entry.error = error instanceof Error ? error.message : String(error);
      if (intentId) this.#control.outcome({ intentId, ok: false, uncertain: true });
      this.#control?.milestone({ kind: action.type, risk: risk.class, outcome: "failed" });
      throw error;
    }
    if (intentId) this.#control.outcome({ intentId, ok: true });
    this.#control?.milestone({ kind: action.type, risk: risk.class, outcome: "done" });
    const after = changes || action.type === "desktop_screenshot" ? await this.#evidence(action.type === "desktop_screenshot" ? "screen" : "after").catch(() => null) : null;
    entry.outcome = "done";
    entry.evidence = [before, after].filter(Boolean).map(({ digest, bytes, path }) => ({ digest, bytes, path }));
    if (action.type === "desktop_screenshot" && after) result = { digest: after.digest, bytes: after.bytes, path: after.path };
    return { action, risk, result, evidence: entry.evidence };
  }

  async #execute(action) {
    const d = this.#driver;
    switch (action.type) {
      case "desktop_observe": return this.observe();
      case "desktop_screenshot": return null;
      case "focus_window": return d.focus(action.title);
      case "desktop_click": return d.click(action);
      case "desktop_move": return d.move(action);
      case "desktop_type": return d.type(action.text);
      case "desktop_key": return d.key(action.keys);
      case "desktop_scroll": return d.scroll(action);
      case "launch_app": return d.launch(action.app);
      case "clipboard_read": return { text: (await d.clipboardRead()).slice(0, 4000) };
      case "clipboard_write": return d.clipboardWrite(action.text);
      default: throw new DesktopError("INVALID_ACTION", "Unsupported desktop action.");
    }
  }
}

/** Typed text can be private; the log keeps its length, not its content. */
function redactForLog(action) {
  if (action.type === "desktop_type" || action.type === "clipboard_write") return { ...action, text: `[${action.text.length} characters]` };
  return action;
}
