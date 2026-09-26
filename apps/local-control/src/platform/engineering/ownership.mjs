import { commitConfig, git, identityEnvironment, refExists, resolveCommit, DEFAULT_IDENTITY } from "./git.mjs";
import { assertAgentBranch } from "./worktrees.mjs";

/**
 * File-ownership plan for an engineering family (blueprint §7).
 *
 * - Each child agent role owns a set of path globs. Two roles whose globs can
 *   match a common path are reported as an overlap — decided exactly, by
 *   intersecting the globs as automata, not by comparing prefixes.
 * - `shared` globs (package manifests, lockfiles, changelogs) may be written
 *   by any role; touching them is expected to need a reviewed merge.
 * - Roles declare dependencies; `order` is a deterministic topological order
 *   and cycles or unknown dependencies are refused.
 * - `reconcileChangeSets` merges child branches in that order with
 *   `git merge-tree --write-tree` (a true three-way merge that never touches
 *   any working tree). A textual conflict stops the merge and is returned as
 *   an escalation; nothing is auto-resolved. Files touched by more than one
 *   role that merged cleanly are still listed for human review.
 */
export class OwnershipError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "OwnershipError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export const ENGINEERING_ROLES = Object.freeze(["frontend", "backend", "database", "testing", "security", "deployment"]);

// --------------------------------------------------------------------------
// Globs

/** Normalizes a glob: forward slashes, no leading "./" or "/", "dir/" means "dir/**". */
export function normalizeGlob(glob) {
  if (typeof glob !== "string" || glob.trim() === "") throw new OwnershipError("INVALID_GLOB", "A path glob must be a non-empty string.");
  let value = glob.trim().replace(/\\/g, "/").replace(/^(?:\.\/)+/, "").replace(/^\/+/, "");
  if (value.split("/").includes("..")) throw new OwnershipError("INVALID_GLOB", `Glob '${glob}' may not contain '..'.`);
  if (value.endsWith("/")) value = `${value}**`;
  if (value === "") throw new OwnershipError("INVALID_GLOB", "A path glob must name something.");
  return value;
}

/**
 * Compiles a glob to an NFA: `nodes[i] = { eps: number[], edges: [{ kind, char?, to }] }`,
 * accept state is the last node. kind: "lit" | "nonslash" | "any".
 *   `?` one non-slash char; `*` any run of non-slash chars; `**` any run of
 *   chars; `**` followed by `/` is "zero or more whole directories".
 */
function compileGlob(glob) {
  const nodes = [];
  const node = () => { nodes.push({ eps: [], edges: [] }); return nodes.length - 1; };
  let current = node();
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i];
    if (char === "*" && glob[i + 1] === "*") {
      const directoryForm = glob[i + 2] === "/";
      i += directoryForm ? 2 : 1;
      const next = node();
      if (directoryForm) {
        const inner = node();
        nodes[current].eps.push(next);
        nodes[current].edges.push({ kind: "any", to: inner });
        nodes[inner].edges.push({ kind: "any", to: inner });
        nodes[inner].edges.push({ kind: "lit", char: "/", to: next });
        nodes[current].edges.push({ kind: "lit", char: "/", to: next });
      } else {
        nodes[current].eps.push(next);
        nodes[current].edges.push({ kind: "any", to: current });
      }
      current = next;
    } else if (char === "*") {
      const next = node();
      nodes[current].eps.push(next);
      nodes[current].edges.push({ kind: "nonslash", to: current });
      current = next;
    } else if (char === "?") {
      const next = node();
      nodes[current].edges.push({ kind: "nonslash", to: next });
      current = next;
    } else {
      const next = node();
      nodes[current].edges.push({ kind: "lit", char, to: next });
      current = next;
    }
  }
  return { nodes, accept: current, literals: new Set(glob.replace(/[*?]/g, "")) };
}

function closure(nfa, states) {
  const seen = new Set(states);
  const stack = [...states];
  while (stack.length) {
    const state = stack.pop();
    for (const next of nfa.nodes[state].eps) if (!seen.has(next)) { seen.add(next); stack.push(next); }
  }
  return seen;
}

function edgeMatches(edge, symbol) {
  if (edge.kind === "any") return true;
  if (edge.kind === "nonslash") return symbol !== "/";
  return edge.char === symbol;
}

function step(nfa, states, symbol) {
  const next = new Set();
  for (const state of states) for (const edge of nfa.nodes[state].edges) if (edgeMatches(edge, symbol)) next.add(edge.to);
  return closure(nfa, next);
}

const globCache = new Map();
function compiled(glob) {
  let value = globCache.get(glob);
  if (!value) { value = compileGlob(glob); globCache.set(glob, value); }
  return value;
}

/** True when `path` matches `glob` (both repository-relative, forward slashes). */
export function matchesGlob(glob, path) {
  const nfa = compiled(normalizeGlob(glob));
  let states = closure(nfa, [0]);
  for (const char of String(path).replace(/\\/g, "/").replace(/^(?:\.\/)+/, "")) {
    states = step(nfa, states, char);
    if (states.size === 0) return false;
  }
  return states.has(nfa.accept);
}

/**
 * True when some path matches both globs (exact: product-automaton
 * reachability over the globs' literal characters, '/', and one stand-in for
 * every other character).
 */
export function globsIntersect(first, second) {
  const a = compiled(normalizeGlob(first));
  const b = compiled(normalizeGlob(second));
  const alphabet = [...new Set([...a.literals, ...b.literals, "/", "\u0000"])];
  const key = (sa, sb) => `${[...sa].sort().join(",")}|${[...sb].sort().join(",")}`;
  const start = [closure(a, [0]), closure(b, [0])];
  const seen = new Set([key(...start)]);
  const queue = [start];
  while (queue.length) {
    const [sa, sb] = queue.shift();
    if (sa.has(a.accept) && sb.has(b.accept)) return true;
    for (const symbol of alphabet) {
      const na = step(a, sa, symbol);
      if (na.size === 0) continue;
      const nb = step(b, sb, symbol);
      if (nb.size === 0) continue;
      const k = key(na, nb);
      if (!seen.has(k)) { seen.add(k); queue.push([na, nb]); }
    }
  }
  return false;
}

// --------------------------------------------------------------------------
// Plan

/**
 * @param {object} input
 * @param {{role: string, paths: string[], dependsOn?: string[]}[]} input.assignments
 * @param {string[]} [input.shared]  globs any role may write (reviewed merge expected)
 * @param {string[]} [input.roles]   allowed role names (default ENGINEERING_ROLES)
 * @returns a frozen plan `{ assignments, shared, order, overlaps }`
 */
export function createOwnershipPlan({ assignments, shared = [], roles = ENGINEERING_ROLES } = {}) {
  if (!Array.isArray(assignments) || assignments.length === 0) {
    throw new OwnershipError("INVALID_PLAN", "An ownership plan needs at least one role assignment.");
  }
  const allowed = new Set(roles);
  const byRole = new Map();
  for (const assignment of assignments) {
    const role = assignment?.role;
    if (!allowed.has(role)) throw new OwnershipError("UNKNOWN_ROLE", `Role '${String(role).slice(0, 40)}' is not an engineering child role.`);
    if (byRole.has(role)) throw new OwnershipError("DUPLICATE_ROLE", `Role '${role}' is assigned twice.`);
    if (!Array.isArray(assignment.paths) || assignment.paths.length === 0) {
      throw new OwnershipError("INVALID_PLAN", `Role '${role}' must own at least one path glob.`);
    }
    byRole.set(role, {
      role,
      paths: assignment.paths.map(normalizeGlob),
      dependsOn: [...new Set(assignment.dependsOn ?? [])],
    });
  }
  for (const { role, dependsOn } of byRole.values()) {
    for (const dependency of dependsOn) {
      if (dependency === role) throw new OwnershipError("DEPENDENCY_CYCLE", `Role '${role}' depends on itself.`);
      if (!byRole.has(dependency)) throw new OwnershipError("UNKNOWN_DEPENDENCY", `Role '${role}' depends on unassigned role '${dependency}'.`);
    }
  }

  const list = [...byRole.values()];
  const overlaps = [];
  for (let i = 0; i < list.length; i += 1) {
    for (let j = i + 1; j < list.length; j += 1) {
      for (const first of list[i].paths) {
        for (const second of list[j].paths) {
          if (globsIntersect(first, second)) overlaps.push({ roles: [list[i].role, list[j].role], globs: [first, second] });
        }
      }
    }
  }

  return Object.freeze({
    assignments: Object.freeze(list.map((item) => Object.freeze({ ...item, paths: Object.freeze(item.paths), dependsOn: Object.freeze(item.dependsOn) }))),
    shared: Object.freeze(shared.map(normalizeGlob)),
    order: Object.freeze(topologicalOrder(list)),
    overlaps: Object.freeze(overlaps),
  });
}

/** Kahn's algorithm; ties broken by assignment order so the result is stable. */
export function topologicalOrder(assignments) {
  const remaining = new Map(assignments.map((item) => [item.role, new Set(item.dependsOn ?? [])]));
  const order = [];
  while (remaining.size) {
    const ready = [...remaining.entries()].filter(([, deps]) => [...deps].every((dep) => order.includes(dep))).map(([role]) => role);
    if (ready.length === 0) {
      throw new OwnershipError("DEPENDENCY_CYCLE", `Role dependencies form a cycle among: ${[...remaining.keys()].join(", ")}.`, { roles: [...remaining.keys()] });
    }
    for (const role of ready) { order.push(role); remaining.delete(role); }
  }
  return order;
}

export function assignmentFor(plan, role) {
  return plan.assignments.find((item) => item.role === role) ?? null;
}

/** Roles whose owned globs match the path. */
export function ownersOf(plan, path) {
  return plan.assignments.filter((item) => item.paths.some((glob) => matchesGlob(glob, path))).map((item) => item.role);
}

/**
 * Classifies a role's changed files: `owned`, `shared`, and `violations`
 * (files neither owned by the role nor shared).
 */
export function checkChangeSet(plan, role, files) {
  const assignment = assignmentFor(plan, role);
  if (!assignment) throw new OwnershipError("UNKNOWN_ROLE", `Role '${role}' is not in the plan.`);
  const result = { role, owned: [], shared: [], violations: [] };
  for (const file of files) {
    if (assignment.paths.some((glob) => matchesGlob(glob, file))) result.owned.push(file);
    else if (plan.shared.some((glob) => matchesGlob(glob, file))) result.shared.push(file);
    else result.violations.push({ path: file, owners: ownersOf(plan, file) });
  }
  return result;
}

/**
 * Files touched by more than one change set.
 * @param {{role: string, files: string[]}[]} changeSets
 */
export function detectChangeSetConflicts(changeSets) {
  const touched = new Map();
  for (const { role, files } of changeSets) {
    for (const file of files) {
      if (!touched.has(file)) touched.set(file, []);
      if (!touched.get(file).includes(role)) touched.get(file).push(role);
    }
  }
  return [...touched.entries()].filter(([, roles]) => roles.length > 1).map(([path, roles]) => ({ path, roles }));
}

// --------------------------------------------------------------------------
// Reviewed merge

/**
 * Three-way merges agent branches onto `baseCommit` in the given order with
 * `git merge-tree --write-tree`, which computes the merge in the object
 * database only — no working tree or index is touched. Each clean step
 * becomes a two-parent commit. On success, and only when `targetBranch` is
 * given, that branch is created (it must be a new agent branch).
 *
 * Returns
 *   { status: "merged", commit, steps, overlaps, requiresReview }  or
 *   { status: "escalated", conflict: { role, branch, files, messages }, steps, overlaps }
 * An escalation writes no ref. Conflicts are never resolved automatically.
 */
export async function reconcileChangeSets({ repository, baseCommit, branches, targetBranch = undefined, identity = DEFAULT_IDENTITY, message = "Atlas reviewed merge" }) {
  let current = await resolveCommit(repository, baseCommit);
  const steps = [];
  const changeSets = [];
  for (const { role, branch } of branches) {
    assertAgentBranch(branch);
    const head = await resolveCommit(repository, branch);
    const files = (await git(repository, ["diff", "--name-only", "--no-renames", "-z", `${baseCommit}`, head])).stdout.split("\0").filter(Boolean);
    changeSets.push({ role, files });

    const result = await git(repository, ["merge-tree", "--write-tree", "--name-only", "--messages", "-z", current, head], { okCodes: [0, 1] });
    // -z output: "<tree>\0<conflicted path>\0...\0\0<informational messages>"
    const [treeAndFiles, ...messageParts] = result.stdout.split("\0\0");
    const [tree, ...conflictedFiles] = treeAndFiles.split("\0").filter(Boolean);
    if (result.code === 1) {
      const files = [...new Set(conflictedFiles)];
      const messages = messageParts.join("\n").split("\0").filter((part) => /CONFLICT/i.test(part)).slice(0, 20);
      return {
        status: "escalated",
        conflict: { role, branch, files, messages },
        steps,
        overlaps: detectChangeSetConflicts(changeSets),
      };
    }
    const { stdout } = await git(repository, [...commitConfig(identity), "commit-tree", tree, "-p", current, "-p", head, "-m", `${message}: ${role} (${branch})`], { env: identityEnvironment(identity) });
    current = stdout.trim();
    steps.push({ role, branch, head, tree, commit: current });
  }

  if (targetBranch !== undefined) {
    assertAgentBranch(targetBranch);
    if (await refExists(repository, `refs/heads/${targetBranch}`)) {
      throw new OwnershipError("BRANCH_EXISTS", `Integration branch '${targetBranch}' already exists.`);
    }
    // The empty old-value makes update-ref refuse if the ref appeared meanwhile.
    await git(repository, ["update-ref", `refs/heads/${targetBranch}`, current, ""]);
  }
  const overlaps = detectChangeSetConflicts(changeSets);
  return { status: "merged", commit: current, steps, overlaps, requiresReview: overlaps.length > 0, targetBranch: targetBranch ?? null };
}
