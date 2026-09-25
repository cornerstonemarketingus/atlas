/**
 * Declarative seed of the default Atlas organization (blueprint §2).
 *
 * The business organization sits at the top of product direction: a Business
 * Development Executive decides what may be worth building and why, and its
 * Product Executive decides what exactly to build and commissions the peer
 * organizations (Engineering, Design, Computer Operations, Research) through
 * scoped cross-family requests. Those peers are siblings of the business
 * organization, not its children, so commissioning never transfers authority:
 * each peer acts with its own permissions only.
 *
 * Permission sets are deliberately conservative: agents hold narrow
 * read/draft/propose rights, nothing here can deploy, send, pay or submit
 * without the approval flow, and every node holds exactly the union its
 * subtree needs (plus its own) so the subset rule is satisfied by
 * construction. Budgets are reserved top-down.
 */

const b = (toolCalls, wallTimeMs, inputTokens, outputTokens, costMicroUsd) => ({ toolCalls, wallTimeMs, inputTokens, outputTokens, costMicroUsd });
const CHILD_BUDGET = b(200, 1_800_000, 400_000, 100_000, 2_000_000);
const OVERSIGHT_BUDGET = b(200, 1_800_000, 400_000, 100_000, 2_000_000);

const child = (name, role, permissions) => ({ name, role, permissions, persistent: true, budget: CHILD_BUDGET });

/**
 * Permissions of the innovation pipeline (see ../innovation). Proposing,
 * researching, reviewing and commissioning are agent rights; approving a
 * build or a launch is not an agent permission at all — it is a human
 * decision recorded against a Decision Packet digest.
 */
export const INNOVATION_PERMISSIONS = Object.freeze({
  propose: "opportunity.propose",
  research: "opportunity.research",
  review: "opportunity.review",
  council: "opportunity.council",
  commission: "innovation.commission",
  measure: "opportunity.measure",
});

export const DEFAULT_FAMILY_TREE = Object.freeze({
  name: "Atlas Root",
  role: "root",
  family: "atlas",
  persistent: true,
  budget: b(20_000, 360_000_000, 50_000_000, 12_000_000, 250_000_000),
  // Root permissions are the union of the tree below it.
  families: [
    {
      name: "Business Development Executive", role: "business_development_executive", family: "business",
      permissions: ["opportunity.propose", "opportunity.council", "opportunity.measure", "innovation.commission", "analytics.read", "support.read", "web.search"],
      children: [
        {
          name: "Product Executive", role: "product_executive", family: "business",
          permissions: ["opportunity.review", "opportunity.council", "innovation.commission", "repo.read", "document.read"],
          children: [
            child("Market Research Agent", "market_research", ["opportunity.research", "web.search", "web.fetch", "document.read"]),
            child("Competitive Intelligence Agent", "competitive_intelligence", ["opportunity.research", "web.search", "web.fetch"]),
            child("Marketing Agent", "marketing", ["content.draft", "web.search", "analytics.read"]),
            child("Sales Agent", "sales", ["crm.read", "email.draft"]),
            child("Analytics Agent", "analytics", ["analytics.read", "opportunity.measure"]),
            child("Customer Success Agent", "customer_success", ["support.read", "feedback.read", "email.draft", "opportunity.council"]),
            child("Finance Agent", "finance", ["billing.read", "usage.read", "cost.estimate", "opportunity.council"]),
          ],
        },
      ],
    },
    {
      name: "Engineering Parent", role: "parent", family: "engineering",
      permissions: ["opportunity.council"],
      children: [
        child("Architecture Agent", "architecture", ["repo.read", "architecture.review", "opportunity.council"]),
        child("Frontend Agent", "frontend", ["repo.read", "repo.write", "terminal.run_tests"]),
        child("Backend Agent", "backend", ["repo.read", "repo.write", "terminal.run_tests"]),
        child("Database Agent", "database", ["repo.read", "repo.write", "db.read_schema", "db.propose_migration"]),
        child("Testing Agent", "testing", ["repo.read", "terminal.run_tests"]),
        child("Security Agent", "security", ["repo.read", "security.scan", "opportunity.council"]),
        child("Deployment Agent", "deployment", ["repo.read", "deploy.propose"]),
      ],
    },
    {
      name: "Design Parent", role: "parent", family: "design",
      children: [
        child("Product Design Agent", "product_design", ["design.draft", "repo.read", "opportunity.council"]),
        child("UI Agent", "ui", ["design.draft", "repo.read", "repo.write"]),
        child("UX Agent", "ux", ["design.draft", "feedback.read"]),
        child("Accessibility Agent", "accessibility", ["repo.read", "browser.read", "a11y.audit"]),
        child("Visual QA Agent", "visual_qa", ["browser.navigate", "browser.read", "visual.inspect"]),
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
      name: "Research Parent", role: "parent", family: "research",
      permissions: ["opportunity.council"],
      children: [
        child("Web Research Agent", "web_research", ["web.search", "web.fetch", "opportunity.research"]),
        child("Document Analysis Agent", "document_analysis", ["document.read"]),
        child("Fact Checking Agent", "fact_checking", ["web.search", "web.fetch", "document.read", "opportunity.research"]),
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

/** A node's permissions: its own plus everything its subtree needs. */
function subtreePermissions(node) {
  return union([node.permissions ?? [], ...(node.children ?? []).map(subtreePermissions)]);
}

/** A node's budget: its own working share plus every descendant's reservation. */
function subtreeBudget(node) {
  if (!node.children?.length) return node.budget ?? CHILD_BUDGET;
  return (node.children ?? []).map(subtreeBudget).reduce(
    (sum, childBudget) => Object.fromEntries(Object.entries(sum).map(([d, v]) => [d, v + childBudget[d]])),
    { ...CHILD_BUDGET },
  );
}

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
    const familyPerms = tree.families.map(subtreePermissions);
    const oversightPerms = union(tree.oversight.map((o) => o.permissions));
    const root = spawn({
      parentId: null, name: tree.name, role: tree.role, family: tree.family, persistent: true,
      permissions: union([...familyPerms, oversightPerms]), budget: tree.budget,
    });
    const spawnSubtree = (node, parentId, family) => {
      const agent = spawn({
        parentId, name: node.name, role: node.role, family, persistent: true,
        permissions: subtreePermissions(node), budget: subtreeBudget(node),
      });
      for (const c of node.children ?? []) spawnSubtree(c, agent.id, family);
      return agent;
    };
    const parentIds = tree.families.map((family) => spawnSubtree(family, root.id, family.family).id);
    for (const o of tree.oversight) {
      const agent = spawn({ parentId: root.id, name: o.name, role: o.role, family: "oversight", persistent: true, permissions: o.permissions, budget: OVERSIGHT_BUDGET });
      for (const parentId of parentIds) registry.addRelationship(tenantId, { from: agent.id, to: parentId, type: o.relationship });
    }
    return { rootId: root.id, agents };
  });
}

/** Peer organizations the business organization commissions, by family. */
export const PEER_ORGANIZATIONS = Object.freeze(
  DEFAULT_FAMILY_TREE.families.filter((f) => f.family !== "business").map((f) => Object.freeze({ family: f.family, parent: f.name })),
);
