/**
 * Desktop actions: the vocabulary a model may propose for operating the
 * computer outside the browser, and the deterministic rules that decide
 * whether each one runs, needs the person's approval, or is refused.
 *
 * The model proposes; these rules decide. Like the browser classifier, they
 * are pure functions of the action and what is on screen, so an approval
 * prompt means the same thing every time.
 */

export class DesktopError extends Error {
  constructor(code, message, { blocked = null, unblock = null } = {}) {
    super(message);
    this.name = "DesktopError";
    this.code = code;
    if (blocked) this.blocked = blocked;
    if (unblock) this.unblock = unblock;
  }
}

export const DESKTOP_ACTION_TYPES = Object.freeze([
  "desktop_observe",   // window list + focused window's accessibility tree (read)
  "desktop_screenshot", // capture the screen as evidence (read)
  "focus_window",       // bring a window to the front by title
  "desktop_click",      // click at screen coordinates
  "desktop_move",       // move the pointer
  "desktop_type",       // type text into the focused window
  "desktop_key",        // press a key combination
  "desktop_scroll",     // scroll the wheel
  "launch_app",         // start an application
  "clipboard_read",     // read the clipboard (privacy: approval)
  "clipboard_write",    // replace the clipboard contents
]);

/** Applications Atlas may start without asking. Anything else asks first. */
export const DEFAULT_APP_ALLOWLIST = Object.freeze([
  "notepad", "calculator", "calc", "explorer", "file explorer", "msedge", "edge", "chrome", "firefox", "code", "vscode",
  "gedit", "mousepad", "xcalc", "xclock", "xlogo",
]);

/** Keys the model may name, normalized to lower case. */
export const KEY_NAMES = Object.freeze([
  "ctrl", "alt", "shift", "win", "enter", "tab", "esc", "space", "backspace", "delete", "home", "end", "pageup", "pagedown",
  "up", "down", "left", "right", "insert", "f1", "f2", "f3", "f4", "f5", "f6", "f7", "f8", "f9", "f10", "f11", "f12",
  ..."abcdefghijklmnopqrstuvwxyz0123456789".split(""),
]);

/** Combinations that are never sent: they lock, sign out or escape the session. */
const DENIED_COMBOS = new Set(["ctrl+alt+delete", "win+l", "ctrl+alt+end", "alt+sysrq"]);
/** Combinations that close, delete or open a system-level surface ask first. */
const ASK_COMBOS = new Set(["alt+f4", "ctrl+w", "ctrl+shift+w", "delete", "shift+delete", "win+r", "ctrl+shift+esc", "win+x", "ctrl+q", "win+d"]);

const SENSITIVE_WINDOW = /\b(password|passcode|sign[\s-]?in|log[\s-]?in|bank|banking|pay(?:ment|pal)?|checkout|wallet|crypto|credential|keychain|1password|bitwarden|lastpass|authenticator|security|settings|control panel|registry|regedit|powershell|command prompt|cmd\.exe|terminal|bash|admin)\b/iu;
const SENSITIVE_TEXT = /\b(password|passcode|ssn|social security|card number|cvv|routing number|private key|seed phrase|recovery code)\b|\b\d{13,19}\b/iu;
const CONSEQUENTIAL_TEXT = /\b(rm\s+-rf|del\s+\/|format\s+[a-z]:|shutdown|reboot|remove-item|drop\s+table|git\s+push\s+--force|sudo)\b/iu;

const MAX_TEXT = 2000;

function int(value, field, { min = -100_000, max = 100_000 } = {}) {
  if (!Number.isInteger(value) || value < min || value > max) throw new DesktopError("INVALID_ACTION", `'${field}' must be an integer between ${min} and ${max}.`);
  return value;
}

function str(value, field, max = MAX_TEXT) {
  if (typeof value !== "string" || !value.length || value.length > max) throw new DesktopError("INVALID_ACTION", `'${field}' must be text of 1–${max} characters.`);
  return value;
}

/** Normalizes "Ctrl + Shift + S" → "ctrl+shift+s"; refuses unknown key names. */
export function normalizeKeys(value) {
  const parts = str(value, "keys", 64).toLowerCase().replace(/\s+/gu, "").split("+").filter(Boolean)
    .map((k) => ({ control: "ctrl", return: "enter", escape: "esc", windows: "win", super: "win", meta: "win", cmd: "win", del: "delete", pgup: "pageup", pgdn: "pagedown" }[k] ?? k));
  if (!parts.length || parts.length > 4) throw new DesktopError("INVALID_ACTION", "A key combination has one to four keys.");
  const unknown = parts.filter((k) => !KEY_NAMES.includes(k));
  if (unknown.length) throw new DesktopError("INVALID_ACTION", `Unknown key: ${unknown.join(", ")}.`);
  const modifiers = ["ctrl", "alt", "shift", "win"];
  const ordered = [...parts.filter((k) => modifiers.includes(k)).sort((a, b) => modifiers.indexOf(a) - modifiers.indexOf(b)), ...parts.filter((k) => !modifiers.includes(k))];
  return ordered.join("+");
}

/** Validates and normalizes one proposed desktop action. */
export function validateDesktopAction(action) {
  if (!action || typeof action !== "object" || Array.isArray(action)) throw new DesktopError("INVALID_ACTION", "An action must be an object.");
  const { type } = action;
  if (!DESKTOP_ACTION_TYPES.includes(type)) throw new DesktopError("INVALID_ACTION", `Unknown desktop action '${String(type).slice(0, 40)}'.`);
  switch (type) {
    case "desktop_observe":
    case "desktop_screenshot":
    case "clipboard_read":
      return { type };
    case "focus_window": return { type, title: str(action.title, "title", 300) };
    case "desktop_click": return { type, x: int(action.x, "x", { min: 0 }), y: int(action.y, "y", { min: 0 }), button: ["left", "right", "middle"].includes(action.button) ? action.button : "left", double: action.double === true };
    case "desktop_move": return { type, x: int(action.x, "x", { min: 0 }), y: int(action.y, "y", { min: 0 }) };
    case "desktop_type": return { type, text: str(action.text, "text") };
    case "desktop_key": return { type, keys: normalizeKeys(action.keys) };
    case "desktop_scroll": return { type, dy: int(action.dy ?? 0, "dy", { min: -50, max: 50 }), dx: int(action.dx ?? 0, "dx", { min: -50, max: 50 }) };
    case "launch_app": {
      const app = str(action.app, "app", 120).trim();
      if (/[\\/:;&|<>"'`$%]/u.test(app)) throw new DesktopError("INVALID_ACTION", "launch_app takes an application name, not a path or command.");
      return { type, app };
    }
    case "clipboard_write": return { type, text: str(action.text, "text") };
    default: throw new DesktopError("INVALID_ACTION", "Unsupported desktop action.");
  }
}

/**
 * @param {object} action a validated action
 * @param {{ activeWindowTitle?: string, appAllowlist?: string[] }} [context]
 * @returns {{ decision: "allow"|"ask"|"deny", class: string, reason: string }}
 */
export function desktopRisk(action, { activeWindowTitle = "", appAllowlist = DEFAULT_APP_ALLOWLIST } = {}) {
  const inSensitiveWindow = SENSITIVE_WINDOW.test(activeWindowTitle);
  const where = activeWindowTitle ? ` in “${activeWindowTitle.slice(0, 80)}”` : "";
  switch (action.type) {
    case "desktop_observe":
    case "desktop_screenshot":
      return { decision: "allow", class: "read", reason: "Look at the screen" };
    case "focus_window":
    case "desktop_move":
    case "desktop_scroll":
      return { decision: "allow", class: "navigate", reason: "Move around without changing anything" };
    case "desktop_click":
      return inSensitiveWindow
        ? { decision: "ask", class: "sensitive_input", reason: `Click${where}` }
        : { decision: "allow", class: "input", reason: "Click in an ordinary window" };
    case "desktop_type":
      if (SENSITIVE_TEXT.test(action.text)) return { decision: "ask", class: "sensitive_input", reason: `Type sensitive information${where}` };
      if (CONSEQUENTIAL_TEXT.test(action.text)) return { decision: "ask", class: "destructive", reason: `Type a command that can change or delete things${where}` };
      if (inSensitiveWindow) return { decision: "ask", class: "sensitive_input", reason: `Type${where}` };
      return { decision: "allow", class: "input", reason: "Type into an ordinary window" };
    case "desktop_key":
      if (DENIED_COMBOS.has(action.keys)) return { decision: "deny", class: "unsupported", reason: `${action.keys} would lock or leave the session` };
      if (ASK_COMBOS.has(action.keys)) return { decision: "ask", class: "destructive", reason: `Press ${action.keys}${where}` };
      if (action.keys === "enter" && inSensitiveWindow) return { decision: "ask", class: "submit", reason: `Press Enter${where}` };
      return { decision: "allow", class: "input", reason: `Press ${action.keys}` };
    case "launch_app":
      return appAllowlist.includes(action.app.toLowerCase())
        ? { decision: "allow", class: "navigate", reason: `Open ${action.app}` }
        : { decision: "ask", class: "transfer", reason: `Start ${action.app}, which is not on the allowed list` };
    case "clipboard_read":
      return { decision: "ask", class: "sensitive_input", reason: "Read what is on your clipboard" };
    case "clipboard_write":
      return SENSITIVE_TEXT.test(action.text)
        ? { decision: "ask", class: "sensitive_input", reason: "Put sensitive text on the clipboard" }
        : { decision: "allow", class: "input", reason: "Replace the clipboard contents" };
    default:
      return { decision: "deny", class: "unsupported", reason: "Unsupported desktop action" };
  }
}
