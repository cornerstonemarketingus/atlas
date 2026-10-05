/**
 * Capabilities an agent run mounts. An agent is not a kind (chat, coder,
 * computer, Genesis); it is one kernel process with capabilities attached for
 * this run. Each capability is a named group of tool-registry capabilities,
 * so a new harness or tool joins a capability instead of adding a new kind
 * of agent.
 *
 * Mounting narrows, it never widens: the tools a run gets are those in its
 * mounted capabilities AND allowed by the agent's permissions, and every call
 * still passes the local allow/ask/deny policy and approvals. A capability
 * with no tools installed at all is reported as a gap (for the capability loop:
 * Atlas can then find or build it) rather than silently missing.
 */
export const CAPABILITIES = Object.freeze({
  code: Object.freeze(["repository.read", "repository.write", "repository.git", "repository.execute", "filesystem.read", "filesystem.write"]),
  browser: Object.freeze(["browser.control", "browser.read", "browser.submit", "browser.upload"]),
  computer: Object.freeze(["desktop.observe", "desktop.control"]),
  terminal: Object.freeze(["terminal.run", "repository.execute"]),
  research: Object.freeze(["browser.control", "browser.read", "filesystem.read", "repository.read"]),
  database: Object.freeze(["database.read", "database.write"]),
  email: Object.freeze(["communications.draft", "communications.send"]),
  payments: Object.freeze(["payments.quote", "payments.pay"]),
  deploy: Object.freeze(["infrastructure.read", "infrastructure.write", "deploy.remote", "publish.remote"]),
  design: Object.freeze(["filesystem.read", "filesystem.write", "genesis.build"]),
  vision: Object.freeze(["desktop.observe", "browser.read"]),
  automation: Object.freeze(["workflow.prepare"]),
  opportunity: Object.freeze(["opportunity.read", "opportunity.scout", "opportunity.pursue"]),
  atlas: Object.freeze(["genesis.build", "innovation.build", "atlas.self_improve"]),
});

export class CapabilityError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "CapabilityError";
    this.code = code;
  }
}

/** The capabilities that contain at least one of these tool capabilities. */
export function capabilitiesCovering(toolCapabilities) {
  const allowed = new Set(toolCapabilities);
  return Object.entries(CAPABILITIES).filter(([, members]) => members.some((member) => allowed.has(member))).map(([name]) => name);
}

/**
 * The tools a run may use.
 *
 * @param {object} toolRegistry  the agent tool registry (list(), toModelTools())
 * @param {{ capabilities: string[], allowedToolCapabilities?: Iterable<string> | null }} options
 *   `allowedToolCapabilities` is the agent's permission ceiling; null means no extra ceiling.
 * @returns {{ mounted: { name: string, tools: string[] }[], gaps: string[], names: Set<string>, tools: object[] }}
 */
export function mountCapabilities(toolRegistry, { capabilities, allowedToolCapabilities = null }) {
  const unknown = capabilities.filter((name) => !CAPABILITIES[name]);
  if (unknown.length) throw new CapabilityError("UNKNOWN_CAPABILITY", `Unknown capability: ${unknown.join(", ")}. Known: ${Object.keys(CAPABILITIES).join(", ")}.`);
  const ceiling = allowedToolCapabilities ? new Set(allowedToolCapabilities) : null;
  const registered = toolRegistry.list();
  const names = new Set();
  const mounted = [];
  const gaps = [];
  for (const capability of [...new Set(capabilities)]) {
    const members = new Set(CAPABILITIES[capability].filter((member) => !ceiling || ceiling.has(member)));
    const tools = registered.filter((tool) => members.has(tool.capability)).map((tool) => tool.name);
    // A gap is a capability Atlas has no tool for at all; one this agent is not permitted is not a gap.
    if (!registered.some((tool) => CAPABILITIES[capability].includes(tool.capability))) gaps.push(capability);
    for (const name of tools) names.add(name);
    mounted.push({ name: capability, tools });
  }
  return { mounted, gaps, names, tools: toolRegistry.toModelTools().filter((tool) => names.has(tool.function.name)) };
}
