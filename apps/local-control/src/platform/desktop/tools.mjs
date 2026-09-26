import { assertSchema, defineTool } from "../../../../../packages/atlas-contracts/src/index.mjs";

/**
 * Platform tool contracts (for AuthorizedToolExecutor) over a DesktopController.
 *
 * Named `desktop.session.*` so they sit beside, not on top of, the daemon's
 * existing ToolRegistry tools (`desktop.observe`, `desktop.screenshot`,
 * `desktop.act`), which keep working unchanged and can themselves be bound to
 * an approved session via `controller.guardedSession(sessionId)`.
 *
 * `desktop.session.open` cannot run without an approval id, and the id must
 * name an owner-approved, unused approval for this device. Every other tool
 * names its session, so each call walks the controller's pipeline (emergency
 * stop, TTL, enrollment, scope, policy hook) and then the companion's rules,
 * whose consequential actions still need their own digest-bound approval.
 *
 * Each execute re-validates its input so a caller that skips the executor's
 * validation still cannot hand the controller an unexpected shape.
 */
const SESSION_ID = { type: "string", pattern: "^wks_[0-9a-f]{32}$" };
const APPROVAL_ID = { type: "string", pattern: "^apr_[0-9a-f]{32}$" };
const COORD = { type: "integer", minimum: 0, maximum: 100_000 };
const TARGET = {
  type: "object",
  additionalProperties: false,
  properties: {
    ref: { type: "string", pattern: "^el_[0-9a-f]{20}$" },
    name: { type: "string", minLength: 1, maxLength: 500 },
    role: { type: "string", minLength: 1, maxLength: 64 },
    app: { type: "string", minLength: 1, maxLength: 120 },
  },
};

function schema(required, properties) {
  return { type: "object", additionalProperties: false, required, properties };
}

/** Drops Buffers and other non-JSON values so outputs cross the executor boundary cleanly. */
function plain(value) {
  return value === undefined ? null : JSON.parse(JSON.stringify(value));
}

export function desktopToolDefinitions(controller) {
  const specs = [
    {
      name: "desktop.session.open",
      description: "Open a short-lived, scoped desktop control session. Requires an approval id the device owner approved; shows the active-control indicator.",
      risk: "moderate",
      inputSchema: schema(["approvalId"], { approvalId: APPROVAL_ID, requestedBy: { type: "string", minLength: 1, maxLength: 200 } }),
      execute: (input) => controller.createSession(input),
    },
    {
      name: "desktop.session.capabilities",
      description: "Report what the bound desktop driver can actually do; unsupported capabilities are listed with reasons.",
      risk: "read",
      inputSchema: schema([], {}),
      execute: async () => controller.capabilities(),
    },
    {
      name: "desktop.session.observe",
      description: "Windows plus the focused window's accessibility elements with refs (prefer refs over coordinates); optionally a screenshot stored by digest.",
      risk: "read",
      inputSchema: schema(["sessionId"], { sessionId: SESSION_ID, screenshot: { type: "boolean" } }),
      execute: ({ sessionId, screenshot = false }, { signal } = {}) => controller.observe(sessionId, { screenshot }, { signal }),
    },
    {
      name: "desktop.session.screenshot",
      description: "Capture the screen; returns the digest under which the image is stored.",
      risk: "read",
      inputSchema: schema(["sessionId"], { sessionId: SESSION_ID }),
      execute: ({ sessionId }, { signal } = {}) => controller.screenshot(sessionId, {}, { signal }),
    },
    {
      name: "desktop.session.focus_window",
      description: "Bring an in-scope window to the front by id or title.",
      risk: "low",
      inputSchema: schema(["sessionId"], { sessionId: SESSION_ID, windowId: { type: "string", minLength: 1, maxLength: 128 }, title: { type: "string", minLength: 1, maxLength: 300 } }),
      execute: ({ sessionId, windowId, title }, { signal } = {}) => controller.focusWindow(sessionId, { windowId, title }, { signal }),
    },
    {
      name: "desktop.session.click",
      description: "Click an element by ref (preferred) or, as a flagged fallback, at screen coordinates. Only inside approved apps/windows.",
      risk: "moderate",
      inputSchema: schema(["sessionId"], { sessionId: SESSION_ID, target: TARGET, x: COORD, y: COORD, button: { enum: ["left", "middle", "right"] } }),
      execute: ({ sessionId, ...params }, { signal } = {}) => controller.click(sessionId, params, { signal }),
    },
    {
      name: "desktop.session.type_text",
      description: "Type text into the target element or the focused window. Refused outside the session's approved apps; sensitive or destructive text needs a digest-bound approval. Text is redacted in the audit trail.",
      risk: "moderate",
      inputSchema: schema(["sessionId", "text"], { sessionId: SESSION_ID, text: { type: "string", minLength: 1, maxLength: 2000 }, target: TARGET }),
      execute: ({ sessionId, text, target }, { signal } = {}) => controller.typeText(sessionId, { text, target }, { signal }),
    },
    {
      name: "desktop.session.key_press",
      description: "Press a key or chord (e.g. 'enter', 'ctrl+s') in an in-scope window.",
      risk: "moderate",
      inputSchema: schema(["sessionId", "key"], { sessionId: SESSION_ID, key: { type: "string", minLength: 1, maxLength: 64 }, target: TARGET }),
      execute: ({ sessionId, key, target }, { signal } = {}) => controller.keyPress(sessionId, { key, target }, { signal }),
    },
    {
      name: "desktop.session.scroll",
      description: "Scroll the focused in-scope window by wheel clicks.",
      risk: "low",
      inputSchema: schema(["sessionId"], { sessionId: SESSION_ID, dx: { type: "integer", minimum: -50, maximum: 50 }, dy: { type: "integer", minimum: -50, maximum: 50 } }),
      execute: ({ sessionId, dx, dy }, { signal } = {}) => controller.scroll(sessionId, { dx, dy }, { signal }),
    },
    {
      name: "desktop.session.launch_app",
      description: "Launch an app by allowlisted name (never a command line). It must also be in the session's approved scope.",
      risk: "moderate",
      inputSchema: schema(["sessionId", "app"], { sessionId: SESSION_ID, app: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9 _.-]{0,63}$" } }),
      execute: ({ sessionId, app }, { signal } = {}) => controller.launchApp(sessionId, { app }, { signal }),
    },
    {
      name: "desktop.session.read_file",
      description: "Read a file under one of the permitted directories.",
      risk: "low",
      inputSchema: schema(["sessionId", "path"], { sessionId: SESSION_ID, path: { type: "string", minLength: 1, maxLength: 4096 } }),
      execute: ({ sessionId, path }, { signal } = {}) => controller.readFile(sessionId, { path }, { signal }),
    },
    {
      name: "desktop.session.pause",
      description: "Pause a session: the in-flight action is aborted and actions are refused until resumed.",
      risk: "low",
      inputSchema: schema(["sessionId"], { sessionId: SESSION_ID }),
      execute: ({ sessionId }) => controller.pause(sessionId),
    },
    {
      name: "desktop.session.resume",
      description: "Resume a paused, unexpired session.",
      risk: "low",
      inputSchema: schema(["sessionId"], { sessionId: SESSION_ID }),
      execute: ({ sessionId }) => controller.resume(sessionId),
    },
    {
      name: "desktop.session.end",
      description: "End a session and turn off the active-control indicator.",
      risk: "low",
      inputSchema: schema(["sessionId"], { sessionId: SESSION_ID }),
      execute: ({ sessionId }) => controller.stop(sessionId, { reason: "ended by agent" }),
    },
    {
      name: "desktop.emergency_stop",
      description: "Halt all desktop control now: abort in-flight actions and close every session. Only a person can re-arm.",
      risk: "low",
      inputSchema: schema([], { reason: { type: "string", maxLength: 500 } }),
      execute: ({ reason = "emergency stop via tool" }) => controller.emergencyStop({ by: "agent", reason }),
    },
  ];

  return specs.map(({ execute, ...spec }) => defineTool({
    ...spec,
    execute: async (input, context = {}) => {
      assertSchema(spec.inputSchema, input, `${spec.name} input`);
      return { output: plain(await execute(input, context)), evidence: [{ kind: "desktop_session", tool: spec.name }] };
    },
  }));
}
