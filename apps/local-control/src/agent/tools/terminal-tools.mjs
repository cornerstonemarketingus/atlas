/**
 * Terminal tools for the local agent runtime, backed by the platform
 * TerminalController: no shell, an executable allowlist, per-session
 * workspace confinement, a filtered environment, timeouts, output caps and
 * secret redaction. Commands the controller rates high-risk (deleting,
 * network access, …) need an approval bound to that exact command.
 *
 * Each agent session gets its own scratch workspace, created on first use.
 */
export class TerminalToolError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "TerminalToolError";
    this.code = code;
  }
}

const TENANT = "local";

export function registerTerminalTools(registry, { controller }) {
  let resolved = typeof controller === "function" ? undefined : controller;
  const need = async () => {
    if (resolved === undefined) {
      try { resolved = await controller(); }
      catch (error) { resolved = null; throw new TerminalToolError("NO_TERMINAL", error?.message ?? "The terminal is not available on this machine."); }
    }
    if (!resolved) throw new TerminalToolError("NO_TERMINAL", "The terminal is not available on this machine.");
    return resolved;
  };
  const workspaces = new Map();
  const workspaceFor = async (sessionId) => {
    const key = sessionId || "default";
    if (!workspaces.has(key)) workspaces.set(key, (await need()).createWorkspace({ tenantId: TENANT, taskId: key }).id);
    return workspaces.get(key);
  };

  registry.register({
    name: "terminal.run",
    description: "Run one command in this conversation's scratch workspace, as an argv array (no shell, no pipes). Allowed programs include node, npm, npx, git, python3 and common file utilities. Returns the exit code and redacted output.",
    capability: "terminal.run",
    risk: "moderate",
    timeoutMs: 620_000,
    maxOutputCharacters: 16_000,
    requiresApproval: false,
    inputSchema: {
      type: "object",
      required: ["argv"],
      properties: {
        argv: { type: "array", maxItems: 64, items: { type: "string", minLength: 1, maxLength: 4096 } },
        cwd: { type: "string", maxLength: 1024 },
        timeoutMs: { type: "integer", minimum: 1, maximum: 600_000 },
        network: { type: "boolean" },
      },
    },
    async execute({ input, context = {} }) {
      if (!input.argv.length) throw new TerminalToolError("INVALID_INPUT", "argv needs at least the program name.");
      const terminal = await need();
      const workspaceId = await workspaceFor(context.sessionId);
      const handle = await terminal.runCommand(workspaceId, { argv: input.argv, cwd: input.cwd ?? ".", timeoutMs: input.timeoutMs, network: input.network === true });
      if (handle.status === "requires_approval") {
        throw new TerminalToolError("APPROVAL_REQUIRED", `Running \`${input.argv.join(" ")}\` needs your approval (${handle.reasons.join("; ")}). Approve it in Atlas, then ask again.`);
      }
      const result = await handle.result;
      const parts = [`exit code ${result.exitCode ?? "none"}${result.signal ? ` (signal ${result.signal})` : ""}`];
      if (result.stdout) parts.push(`stdout:\n${result.stdout}`);
      if (result.stderr) parts.push(`stderr:\n${result.stderr}`);
      return parts.join("\n");
    },
  });
}
