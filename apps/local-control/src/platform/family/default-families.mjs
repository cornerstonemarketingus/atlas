/**
 * Declarative seed of the example family tree (blueprint §2). Permission sets
 * are deliberately conservative: children hold narrow read/draft/propose
 * rights, nothing here can deploy, send, pay or submit without the approval
 * flow, and each parent holds exactly the union its children need so the
 * subset rule is satisfied by construction. Budgets are reserved top-down.
 */

const b = (toolCalls, wallTimeMs, inputTokens, outputTokens, costMicroUsd) => ({ toolCalls, wallTimeMs, inputTokens, outputTokens, costMicroUsd });
const CHILD_BUDGET = b(200, 1_800_000, 400_000, 100_000, 2_000_000);
const OVERSIGHT_BUDGET = b(200, 1_800_000, 400_000, 100_000, 2_000_000);

const child = (name, role, permissions) => ({ name, role, permissions, persistent: true, budget: CHILD_BUDGET });

export const DEFAULT_FAMILY_TREE = Object.freeze({
  name: "Atlas Root",
  role: "root",
  family: "atlas",
  persistent: true,
  budget: b(20_000, 360_000_000, 50_000_000, 12_000_000, 250_000_000),
  // Root permissions are the union of the tree below it.
  families: [
    {
      name: "Engineering Parent", role: "parent", family: "engineering",
      children: [
        child("Frontend Agent", "frontend", ["repo.read", "repo.write", "terminal.run_tests"]),
        child("Backend Agent", "backend", ["repo.read", "repo.write", "terminal.run_tests"]),
        child("Database Agent", "database", ["repo.read", "repo.write", "db.read_schema", "db.propose_migration"]),
        child("Testing Agent", "testing", ["repo.read", "terminal.run_tests"]),
        child("Security Agent", "security", ["repo.read", "security.scan"]),
        child("Deployment Agent", "deployment", ["repo.read", "deploy.propose"]),
      ],
    },
    {
      name: "Computer Operations Parent", role: "parent", family: "computer_operations",
      children: [
        child("Browser Agent", "browser", ["browser.navigate", "browser.read"]),
        child("Desktop Agent", "desktop", ["desktop.observe", "desktop.input"]),
        child("Terminal Agent", "terminal", ["terminal.run_tests", "terminal.run_readonly"]),
        child("Recovery Agent", "recovery", ["browser.read", "desktop.observe", "worker.restart"]),
      ],
    },
    {
      name: "Business Parent", role: "parent", family: "business",
      children: [
        child("Sales Agent", "sales", ["crm.read", "email.draft"]),
        child("Marketing Agent", "marketing", ["content.draft", "web.search"]),
        child("Customer Support Agent", "customer_support", ["support.read", "email.draft"]),
      ],
    },
    {
      name: "Research Parent", role: "parent", family: "research",
      children: [
        child("Web Research Agent", "web_research", ["web.search", "web.fetch"]),
        child("Document Analysis Agent", "document_analysis", ["document.read"]),
        child("Fact Checking Agent", "fact_checking", ["web.search", "web.fetch", "document.read"]),
      ],
    },
  ],
  oversight: [
    { name: "Reviewer", role: "reviewer", relationship: "reviews", permissions: ["repo.read", "document.read"] },
    { name: "Guardian", role: "guardian", relationship: "guards", permissions: ["audit.read", "policy.read"] },
    { name: "Mentor", role: "mentor", relationship: "mentors", permissions: ["memory.read"] },
  ],
});

const union = (lists) => [...new Set(lists.flat())].sort();

/**
 * Creates the default tree for a tenant through the policy-checked path
 * (propose + authorize). Idempotent: an existing "Atlas Root" is returned.
 * @returns {{ rootId: string, agents: Record<string, string> }} name → agent id
 */
export function seedFamilies(registry, tenantId, { authorizer = "atlas.seed", policy, tree = DEFAULT_FAMILY_TREE } = {}) {
  const existing = registry.listAgents(tenantId).find((a) => a.parentId === null && a.name === tree.name && registry.isLive(a));
  if (existing) {
    const agents = Object.fromEntries([existing, ...registry.descendants(tenantId, existing.id)].map((a) => [a.name, a.id]));
    return { rootId: existing.id, agents };
  }
  return registry.transaction(() => {
    const agents = {};
    const spawn = (spec) => {
      const agent = registry.spawnAgent({ tenantId, requestedBy: authorizer, ...spec }, { authorizer, policy });
      agents[agent.name] = agent.id;
      return agent;
    };
    const familyPerms = tree.families.map((f) => union(f.children.map((c) => c.permissions)));
    const oversightPerms = union(tree.oversight.map((o) => o.permissions));
    const root = spawn({
      parentId: null, name: tree.name, role: tree.role, family: tree.family, persistent: true,
      permissions: union([...familyPerms, oversightPerms]), budget: tree.budget,
    });
    const parentIds = [];
    tree.families.forEach((family, index) => {
      const parentBudget = Object.fromEntries(Object.entries(CHILD_BUDGET).map(([d, v]) => [d, v * (family.children.length + 1)]));
      const parent = spawn({
        parentId: root.id, name: family.name, role: family.role, family: family.family, persistent: true,
        permissions: familyPerms[index], budget: parentBudget,
      });
      parentIds.push(parent.id);
      for (const c of family.children) spawn({ parentId: parent.id, family: family.family, ...c });
    });
    for (const o of tree.oversight) {
      const agent = spawn({ parentId: root.id, name: o.name, role: o.role, family: "oversight", persistent: true, permissions: o.permissions, budget: OVERSIGHT_BUDGET });
      for (const parentId of parentIds) registry.addRelationship(tenantId, { from: agent.id, to: parentId, type: o.relationship });
    }
    return { rootId: root.id, agents };
  });
}
