/**
 * Desktop tools: the local agent runtime operates applications outside the
 * browser through the same DesktopSession the Windows companion uses — the
 * same action vocabulary, the same deterministic risk rules, the same
 * evidence. Two capabilities keep policy legible:
 *
 *   desktop.observe  window list, focused window tree, screenshots
 *   desktop.control  click, type, keys, scroll, focus, launch, clipboard
 *
 * Both default to "ask" in the local policy table. On top of that, actions
 * the session's rules classify as consequential (typing into a banking
 * window, alt+f4, reading the clipboard …) raise their own digest-bound
 * approval, exactly like page-level browser actions.
 */
export class DesktopToolError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "DesktopToolError";
    this.code = code;
  }
}

const ACTION_SCHEMA = {
  type: "object",
  required: ["action"],
  properties: {
    action: {
      type: "object",
      required: ["type"],
      properties: {
        type: { type: "string", enum: ["focus_window", "desktop_click", "desktop_move", "desktop_type", "desktop_key", "desktop_scroll", "launch_app", "clipboard_read", "clipboard_write"] },
        title: { type: "string", maxLength: 300 },
        x: { type: "integer" }, y: { type: "integer" },
        button: { type: "string", enum: ["left", "right", "middle"] },
        double: { type: "boolean" },
        text: { type: "string", maxLength: 2000 },
        keys: { type: "string", maxLength: 64 },
        dx: { type: "integer" }, dy: { type: "integer" },
        app: { type: "string", maxLength: 120 },
      },
    },
  },
};

/**
 * @param registry ToolRegistry
 * @param {{ session: object | (() => Promise<object>) }} options a DesktopSession or a factory for one
 */
export function registerDesktopTools(registry, { session }) {
  let resolved = typeof session === "function" ? undefined : session;
  const need = async () => {
    if (resolved === undefined) {
      try { resolved = await session(); }
      catch (error) {
        resolved = null;
        const hint = error?.unblock ? ` ${error.unblock}` : "";
        throw new DesktopToolError("NO_DESKTOP", `${error?.message ?? "Desktop control is not available on this machine."}${hint}`);
      }
    }
    if (!resolved) throw new DesktopToolError("NO_DESKTOP", "Desktop control is not available on this machine.");
    return resolved;
  };

  registry.register({
    name: "desktop.observe",
    description: "List open windows and describe the focused window's controls (names, roles, screen bounds).",
    capability: "desktop.observe",
    risk: "low",
    timeoutMs: 30_000,
    maxOutputCharacters: 12_000,
    requiresApproval: false,
    inputSchema: { type: "object", properties: {} },
    async execute() {
      const { result } = await (await need()).perform({ type: "desktop_observe" });
      return JSON.stringify(result);
    },
  });

  registry.register({
    name: "desktop.screenshot",
    description: "Capture the screen as local evidence. Returns the image digest and where it was saved, not the image.",
    capability: "desktop.observe",
    risk: "low",
    timeoutMs: 30_000,
    maxOutputCharacters: 1_000,
    requiresApproval: false,
    inputSchema: { type: "object", properties: {} },
    async execute() {
      const { result } = await (await need()).perform({ type: "desktop_screenshot" });
      return `Screenshot ${result.digest} (${result.bytes} bytes)${result.path ? ` saved to ${result.path}` : ""}.`;
    },
  });

  registry.register({
    name: "desktop.act",
    description: "Perform one desktop action: focus_window, desktop_click, desktop_move, desktop_type, desktop_key, desktop_scroll, launch_app, clipboard_read or clipboard_write. Consequential actions pause for the owner's approval.",
    capability: "desktop.control",
    risk: "moderate",
    timeoutMs: 90_000,
    maxOutputCharacters: 4_000,
    requiresApproval: false,
    inputSchema: ACTION_SCHEMA,
    async execute({ input }) {
      const { action, risk, result, evidence } = await (await need()).perform(input.action);
      const shots = evidence.map((e) => e.digest).join(", ");
      const detail = result && typeof result === "object" && "text" in result ? ` Clipboard: ${result.text}` : result?.title ? ` Focused “${result.title}”.` : "";
      return `${risk.reason} — done (${action.type}).${detail}${shots ? ` Evidence: ${shots}.` : ""}`;
    },
  });
}
