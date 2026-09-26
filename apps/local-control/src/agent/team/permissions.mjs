import { permissionsCover } from "../../platform/family/family-graph.mjs";

/**
 * Which tool capabilities an agent's family permissions let it use.
 *
 * This narrows, it never widens: a tool an agent may use still passes the
 * local allow/ask/deny policy and any per-action approval. Consequential
 * capabilities (submitting forms, sending messages, applying infrastructure)
 * appear only when an agent explicitly holds the matching permission, which
 * no default agent does.
 */
export const PERMISSION_CAPABILITIES = Object.freeze({
  "repo.read": ["repository.read", "filesystem.read"],
  "repo.write": ["repository.write", "repository.git", "filesystem.write"],
  "terminal.run_tests": ["repository.execute", "terminal.run"],
  "terminal.run_readonly": ["terminal.run"],
  "browser.navigate": ["browser.control"],
  "browser.read": ["browser.read"],
  "browser.submit": ["browser.submit"],
  "web.search": ["browser.control", "browser.read"],
  "web.fetch": ["browser.control", "browser.read"],
  "desktop.observe": ["desktop.observe"],
  "desktop.input": ["desktop.control"],
  "visual.inspect": ["browser.read", "desktop.observe"],
  "a11y.audit": ["browser.read"],
  "document.read": ["filesystem.read"],
  "content.draft": ["communications.draft", "filesystem.write"],
  "email.draft": ["communications.draft"],
  "email.send": ["communications.send"],
  "deploy.propose": ["infrastructure.read"],
  "deploy.execute": ["infrastructure.write"],
  "design.draft": ["filesystem.write"],
});

export function capabilitiesFor(permissions) {
  const out = new Set();
  for (const [permission, capabilities] of Object.entries(PERMISSION_CAPABILITIES)) {
    if (permissionsCover(permissions, permission)) for (const capability of capabilities) out.add(capability);
  }
  return out;
}

/** The registry's model-facing tool list, narrowed to what this agent may use. */
export function toolsForAgent(toolRegistry, agent) {
  const allowed = capabilitiesFor(agent.permissions);
  const names = new Set(toolRegistry.list().filter((tool) => allowed.has(tool.capability)).map((tool) => tool.name));
  return { names, tools: toolRegistry.toModelTools().filter((tool) => names.has(tool.function.name)) };
}
