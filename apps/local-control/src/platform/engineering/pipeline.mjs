import { join, relative, resolve, sep } from "node:path";
import { TerminalController } from "../terminal/terminal-controller.mjs";
import { addedLines, diffStats, git, resolveCommit } from "./git.mjs";
import { agentBranchName, isInside, realOrResolved, WorktreeManager } from "./worktrees.mjs";
import { assignmentFor, checkChangeSet, reconcileChangeSets } from "./ownership.mjs";
import { DEFAULT_FORBIDDEN_PATHS, forbiddenPathChanges, redactText, scanSecrets, scanSecurityPatterns } from "./review.mjs";
import { buildPullRequestPayload, evaluateMergePolicy, submitPullRequest } from "./pull-request.mjs";

/**
 * EngineeringWorkflow (blueprint §7).
 *
 *   inspect → acceptance_criteria → plan → code → checks → diff_review →
 *   security_scan → integration_test → prepare_pr → request_review
 *
 * Rules the implementation holds to:
 * - Success is derived only from tool output: exit codes and parsed test
 *   counts. What a coder says about its own work is recorded as an
 *   unverified report and never consulted.
 * - Every stage is recorded with its evidence; the first stage that fails,
 *   blocks or escalates stops the run and later stages are `not_run`.
 * - Each child agent works in its own worktree on `atlas/<task>/<role>`.
 *   Children with dependencies start from a reviewed merge of their
 *   dependencies' branches; the final integration branch is a reviewed merge
 *   of all of them. Textual conflicts escalate; nothing is auto-resolved.
 * - The workflow never merges. There is no merge method on it, the PR
 *   adapter has none, and `mergePolicy.result` is always
 *   `human_review_required`.
 */
export const STAGES = Object.freeze([
  "inspect", "acceptance_criteria", "plan", "code", "checks", "diff_review",
  "security_scan", "integration_test", "prepare_pr", "request_review",
]);

const STOPPING = new Set(["failed", "blocked", "escalated"]);
const OUTPUT_TAIL = 4_000;

// --------------------------------------------------------------------------
// Repository inspection

/** Detects manifests and check commands from the file list and package.json. */
export function detectRepositoryCommands(files, packageJson = null) {
  const manifests = files.filter((file) => /(^|\/)(package\.json|pyproject\.toml|Cargo\.toml|go\.mod|pom\.xml|build\.gradle)$/.test(file) && !file.includes("node_modules/"));
  const checks = [];
  const scripts = packageJson?.scripts && typeof packageJson.scripts === "object" ? packageJson.scripts : {};
  const format = ["format:check", "check:format", "lint"].find((name) => typeof scripts[name] === "string");
  if (format) checks.push({ kind: "format", argv: ["npm", "run", "--silent", format] });
  const typecheck = ["typecheck", "check:types", "tsc"].find((name) => typeof scripts[name] === "string");
  if (typecheck) checks.push({ kind: "typecheck", argv: ["npm", "run", "--silent", typecheck] });
  if (typeof scripts.test === "string" && !/no test specified/.test(scripts.test)) {
    checks.push({ kind: "test", argv: ["npm", "test", "--silent"] });
  } else if (files.some((file) => /\.test\.[cm]?js$/.test(file))) {
    checks.push({ kind: "test", argv: ["node", "--test"] });
  } else if (files.includes("pyproject.toml") || files.some((file) => /(^|\/)test_[^/]+\.py$/.test(file))) {
    checks.push({ kind: "test", argv: ["python3", "-m", "unittest", "discover"] });
  }
  return { manifests, checks };
}

/** Parses node:test totals from TAP (`# pass 3`) or spec (`ℹ pass 3`) output. */
export function parseTestCounts(output) {
  const counts = {};
  for (const match of String(output ?? "").matchAll(/^(?:#|ℹ)\s*(tests|pass|fail|cancelled|skipped|todo)\s+(\d+)\s*$/gm)) {
    counts[match[1]] = Number(match[2]);
  }
  if (counts.tests === undefined && counts.pass === undefined && counts.fail === undefined) return null;
  return { tests: counts.tests ?? (counts.pass ?? 0) + (counts.fail ?? 0), pass: counts.pass ?? 0, fail: counts.fail ?? 0, cancelled: counts.cancelled ?? 0 };
}

/** Decides a check's outcome from its exit code and test counts only. */
export function judgeCheck(kind, outcome) {
  const testCounts = kind === "test" ? parseTestCounts(`${outcome.stdout ?? ""}\n${outcome.stderr ?? ""}`) : null;
  const reasons = [];
  if (outcome.status === "requires_approval") reasons.push("command requires approval and did not run");
  if (outcome.timedOut) reasons.push("timed out");
  if (outcome.exitCode !== 0) reasons.push(`exit code ${outcome.exitCode}`);
  if (testCounts && (testCounts.fail > 0 || testCounts.cancelled > 0)) reasons.push(`${testCounts.fail} failing, ${testCounts.cancelled} cancelled test(s)`);
  if (testCounts && testCounts.tests === 0) reasons.push("no tests ran");
  return { passed: reasons.length === 0, testCounts, reasons };
}

// --------------------------------------------------------------------------
// Command runners

const ISOLATING_RUNNERS = new Set(["container", "namespaces"]);

/**
 * The default command runner: the platform TerminalController. Worktrees are
 * placed inside controller workspaces (`prepareDirectory`), so checks run
 * under its policy — no shell, rebuilt environment, timeouts, output caps,
 * redaction. High-risk commands are not approved here and come back as
 * `requires_approval`, which judges as a failed check.
 *
 * `requireIsolation: true` (use it for untrusted repositories) refuses a
 * controller that would run commands with the plain process runner; the
 * controller must be configured with `container` or `namespaces`.
 */
export function createTerminalCommandRunner({ controller, tenantId = "engineering", requireIsolation = false }) {
  const isolation = controller.isolation ?? "process";
  if (requireIsolation === true && !ISOLATING_RUNNERS.has(isolation)) {
    throw new EngineeringWorkflowError("ISOLATION_REQUIRED", `Isolation is required but the terminal controller uses the '${isolation}' runner; configure container or namespaces.`);
  }
  const workspaces = new Map();
  return {
    kind: "terminal-controller",
    isolation,
    prepareDirectory({ taskId, name }) {
      const workspace = controller.createWorkspace({ tenantId, taskId: `${taskId}-${name}` });
      const directory = realOrResolved(workspace.directory);
      workspaces.set(directory, workspace.id);
      return join(directory, "repo");
    },
    async releaseDirectory(path) {
      for (const [directory, id] of workspaces) {
        if (isInside(directory, realOrResolved(path))) {
          workspaces.delete(directory);
          await controller.destroyWorkspace(id).catch(() => {});
        }
      }
    },
    async run({ cwd, argv, timeoutMs = undefined }) {
      const real = realOrResolved(cwd);
      const entry = [...workspaces.entries()].find(([directory]) => isInside(directory, real));
      if (!entry) throw new Error("The terminal runner only runs commands inside workspaces it prepared.");
      const [directory, workspaceId] = entry;
      const started = await controller.runCommand(workspaceId, { argv, cwd: relative(directory, real).split(sep).join("/") || ".", timeoutMs, env: { CI: "1", NO_COLOR: "1" } });
      if (started.status === "requires_approval") {
        return { status: "requires_approval", exitCode: null, stdout: "", stderr: `requires approval: ${started.reasons.join("; ")}`, timedOut: false };
      }
      const result = await started.result;
      return { status: "exited", exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr, timedOut: result.timedOut, durationMs: result.durationMs, redactions: result.redactions };
    },
  };
}

// --------------------------------------------------------------------------
// Workflow

export class EngineeringWorkflowError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "EngineeringWorkflowError";
    this.code = code;
  }
}

function tail(text) {
  const value = redactText(text ?? "");
  return value.length > OUTPUT_TAIL ? `…${value.slice(-OUTPUT_TAIL)}` : value;
}

export class EngineeringWorkflow {
  #repository;
  #ownership;
  #coders;
  #runner;
  #ownsController = null;
  #createPullRequest;
  #forbiddenPaths;
  #worktrees;
  #prepared = new Map();
  #now;

  /**
   * @param {object} options
   * @param {string} options.repository       the operator's checkout (never written)
   * @param {string} options.workDirectory    outside the checkout; worktrees / terminal workspaces live here
   * @param {object} options.ownership        a plan from createOwnershipPlan
   * @param {Record<string, Function>} options.coders  role → async ({ role, worktree, ... }) => any
   * @param {object} [options.commandRunner]  `{ run({cwd, argv}), prepareDirectory?, releaseDirectory? }`; default TerminalController
   * @param {Function} [options.createPullRequest]  async (payload) => { url, number }
   * @param {string[]} [options.forbiddenPaths]
   * @param {boolean} [options.requireIsolation]  refuse to run checks unless commands are sandboxed (container or namespaces)
   * @param {object} [options.terminal]  extra TerminalController options for the default runner, e.g. `{ namespaces: true }`
   */
  constructor({ repository, workDirectory, ownership, coders, commandRunner = undefined, createPullRequest = undefined, forbiddenPaths = DEFAULT_FORBIDDEN_PATHS, identity = undefined, now = () => new Date(), requireIsolation = false, terminal = {} } = {}) {
    if (!ownership?.order) throw new EngineeringWorkflowError("INVALID_INPUT", "An ownership plan is required.");
    if (!coders || typeof coders !== "object") throw new EngineeringWorkflowError("INVALID_INPUT", "coders must map roles to functions.");
    if (typeof workDirectory !== "string" || !workDirectory) throw new EngineeringWorkflowError("INVALID_INPUT", "workDirectory is required.");
    this.#repository = resolve(repository);
    this.#ownership = ownership;
    this.#coders = coders;
    if (commandRunner) {
      // A custom runner must declare its isolation to satisfy the requirement.
      if (requireIsolation === true && !ISOLATING_RUNNERS.has(commandRunner.isolation)) {
        throw new EngineeringWorkflowError("ISOLATION_REQUIRED", "Isolation is required but the command runner does not declare isolation 'container' or 'namespaces'.");
      }
      this.#runner = commandRunner;
    } else {
      try {
        this.#ownsController = new TerminalController({ ...terminal, requireIsolation, rootDirectory: join(workDirectory, "terminal") });
      } catch (error) {
        if (error?.code === "ISOLATION_REQUIRED") throw new EngineeringWorkflowError("ISOLATION_REQUIRED", error.message);
        throw error;
      }
      this.#runner = createTerminalCommandRunner({ controller: this.#ownsController, requireIsolation });
    }
    this.#createPullRequest = createPullRequest;
    this.#forbiddenPaths = forbiddenPaths;
    this.#now = now;
    this.#worktrees = new WorktreeManager({ repository: this.#repository, rootDirectory: join(workDirectory, "worktrees"), ...(identity ? { identity } : {}) });
  }

  get worktrees() { return this.#worktrees; }

  async #directory(taskId, name) {
    if (typeof this.#runner.prepareDirectory !== "function") return undefined;
    const path = await this.#runner.prepareDirectory({ taskId, name });
    this.#prepared.set(`${taskId}/${name}`, path);
    return path;
  }

  async #runChecks(scope, cwd, commands) {
    const results = [];
    for (const command of commands) {
      let outcome;
      try {
        outcome = await this.#runner.run({ cwd, argv: [...command.argv], timeoutMs: command.timeoutMs });
      } catch (error) {
        outcome = { status: "refused", exitCode: null, stdout: "", stderr: String(error?.message ?? error), timedOut: false };
      }
      const verdict = judgeCheck(command.kind, outcome);
      results.push({
        scope, kind: command.kind, argv: [...command.argv], status: outcome.status ?? "exited",
        exitCode: outcome.exitCode ?? null, timedOut: outcome.timedOut === true,
        testCounts: verdict.testCounts, passed: verdict.passed, reasons: verdict.reasons,
        stdout: tail(outcome.stdout), stderr: tail(outcome.stderr),
      });
    }
    return results;
  }

  /**
   * Runs the workflow. Returns
   * `{ taskId, status, stages, branches, pullRequest, mergePolicy, escalation }`
   * where status is `awaiting_human_review`, `failed`, `blocked` or `escalated`.
   */
  async run({ taskId, objective, acceptanceCriteria, baseRef = "HEAD", baseBranch = undefined, mergePolicy = "manual", checks = undefined } = {}) {
    agentBranchName(taskId, "integration"); // validates taskId early
    const stages = [];
    const state = { taskId, children: [], escalation: null, pullRequest: null, mergePolicy: null, integration: null };
    let stopped = null;

    const stage = async (name, body) => {
      if (stopped) { stages.push({ name, status: "not_run", evidence: { reason: `stopped at ${stopped}` } }); return; }
      const startedAt = this.#now().toISOString();
      let outcome;
      try {
        outcome = await body();
      } catch (error) {
        outcome = { status: "failed", evidence: { error: redactText(error?.message ?? String(error)).slice(0, 1_000), code: error?.code ?? null } };
      }
      stages.push({ name, status: outcome.status, startedAt, finishedAt: this.#now().toISOString(), evidence: outcome.evidence });
      if (STOPPING.has(outcome.status)) stopped = name;
    };

    const top = await this.#worktrees.toplevel();

    await stage("inspect", async () => {
      state.baseCommit = await resolveCommit(top, baseRef);
      const files = (await git(top, ["ls-tree", "-r", "--name-only", "-z", state.baseCommit])).stdout.split("\0").filter(Boolean);
      let packageJson = null;
      if (files.includes("package.json")) {
        try { packageJson = JSON.parse((await git(top, ["show", `${state.baseCommit}:package.json`])).stdout); } catch { packageJson = null; }
      }
      const detected = detectRepositoryCommands(files, packageJson);
      state.commands = checks ?? detected.checks;
      state.baseBranch = baseBranch ?? ((await git(top, ["symbolic-ref", "--quiet", "--short", "HEAD"], { okCodes: [0, 1, 128] })).stdout.trim() || "main");
      const evidence = { baseCommit: state.baseCommit, baseBranch: state.baseBranch, fileCount: files.length, manifests: detected.manifests, detectedChecks: detected.checks, checks: state.commands };
      if (!state.commands.some((command) => command.kind === "test")) return { status: "failed", evidence: { ...evidence, reason: "No test command was detected or supplied; the change could not be verified." } };
      return { status: "passed", evidence };
    });

    await stage("acceptance_criteria", async () => {
      const criteria = Array.isArray(acceptanceCriteria) ? acceptanceCriteria.map((item) => (typeof item === "string" ? item.trim() : "")) : [];
      if (criteria.length === 0 || criteria.some((item) => item === "")) {
        return { status: "failed", evidence: { reason: "Acceptance criteria are required: a non-empty list of non-empty statements." } };
      }
      state.acceptanceCriteria = criteria;
      return { status: "passed", evidence: { criteria } };
    });

    await stage("plan", async () => {
      if (this.#ownership.overlaps.length > 0) {
        return { status: "failed", evidence: { reason: "Ownership globs overlap between roles.", overlaps: this.#ownership.overlaps } };
      }
      const roles = this.#ownership.order.filter((role) => typeof this.#coders[role] === "function");
      if (roles.length === 0) return { status: "failed", evidence: { reason: "No role in the ownership plan has a coder." } };
      state.roles = roles;
      const steps = roles.map((role) => {
        const assignment = assignmentFor(this.#ownership, role);
        return { role, branch: agentBranchName(taskId, role), paths: assignment.paths, dependsOn: assignment.dependsOn.filter((dep) => roles.includes(dep)) };
      });
      state.steps = steps;
      return { status: "passed", evidence: { order: roles, steps, shared: this.#ownership.shared } };
    });

    await stage("code", async () => {
      const evidence = [];
      for (const step of state.steps) {
        let base = state.baseCommit;
        if (step.dependsOn.length) {
          const merged = await reconcileChangeSets({
            repository: top, baseCommit: state.baseCommit,
            branches: step.dependsOn.map((dep) => ({ role: dep, branch: agentBranchName(taskId, dep) })),
            identity: this.#worktrees.identity, message: `Atlas dependency merge for ${step.role}`,
          });
          if (merged.status === "escalated") {
            state.escalation = { reason: "merge_conflict", stage: "code", role: step.role, conflict: merged.conflict };
            return { status: "escalated", evidence: { children: evidence, escalation: state.escalation } };
          }
          base = merged.commit;
        }
        const path = await this.#directory(taskId, step.role);
        const handle = await this.#worktrees.create({ taskId, agentRole: step.role, baseRef: base, ...(path ? { path } : {}) });
        let report = null;
        let coderError = null;
        try {
          report = await this.#coders[step.role]({
            role: step.role, worktree: handle.path, branch: handle.branch, objective, acceptanceCriteria: state.acceptanceCriteria,
            ownedPaths: step.paths, sharedPaths: this.#ownership.shared, dependsOn: step.dependsOn,
          });
        } catch (error) {
          coderError = redactText(error?.message ?? String(error)).slice(0, 1_000);
        }
        const commit = coderError ? null : await this.#worktrees.commitAll(handle, `${step.role}: ${String(objective ?? taskId).split("\n")[0].slice(0, 60)}`);
        const files = commit ? (await git(top, ["diff", "--name-only", "--no-renames", "-z", handle.baseCommit, commit])).stdout.split("\0").filter(Boolean) : [];
        const child = { ...step, ...handle, startCommit: handle.baseCommit, commit, files, ownership: checkChangeSet(this.#ownership, step.role, files) };
        state.children.push(child);
        evidence.push({
          role: step.role, branch: handle.branch, startCommit: handle.baseCommit, commit, files, coderError,
          // Recorded for the reviewer; never used to decide success.
          unverifiedCoderReport: report === undefined || report === null ? null : redactText(typeof report === "string" ? report : JSON.stringify(report)).slice(0, 1_000),
        });
        if (coderError) return { status: "failed", evidence: { children: evidence, reason: `The ${step.role} coder threw.` } };
      }
      if (!state.children.some((child) => child.commit)) return { status: "failed", evidence: { children: evidence, reason: "No child produced a change." } };
      return { status: "passed", evidence: { children: evidence } };
    });

    await stage("checks", async () => {
      const results = [];
      for (const child of state.children.filter((item) => item.commit)) {
        results.push(...await this.#runChecks(child.role, child.path, state.commands));
      }
      state.checkResults = results;
      return { status: results.every((result) => result.passed) ? "passed" : "failed", evidence: { results } };
    });

    await stage("diff_review", async () => {
      const perChild = [];
      const lines = [];
      for (const child of state.children.filter((item) => item.commit)) {
        const stats = await diffStats(top, child.startCommit, child.commit);
        const added = await addedLines(top, child.startCommit, child.commit);
        lines.push(...added);
        perChild.push({ role: child.role, stats, ownershipViolations: child.ownership.violations, sharedFiles: child.ownership.shared });
      }
      state.addedLines = lines;
      const files = [...new Set(state.children.flatMap((child) => child.files))];
      const forbidden = forbiddenPathChanges(files, this.#forbiddenPaths);
      const secrets = scanSecrets(lines);
      const violations = perChild.flatMap((item) => item.ownershipViolations.map((violation) => ({ role: item.role, ...violation })));
      state.reviewFindings = { forbidden, secrets, violations };
      const blocked = forbidden.length > 0 || secrets.length > 0 || violations.length > 0;
      return { status: blocked ? "blocked" : "passed", evidence: { perChild, forbidden, secrets, ownershipViolations: violations } };
    });

    await stage("security_scan", async () => {
      const secrets = scanSecrets(state.addedLines);
      const findings = scanSecurityPatterns(state.addedLines);
      state.securityFindings = findings;
      if (secrets.length) return { status: "blocked", evidence: { secrets, findings } };
      return { status: findings.length ? "flagged" : "passed", evidence: { findings } };
    });

    await stage("integration_test", async () => {
      const integrationBranch = agentBranchName(taskId, "integration");
      const children = state.children.filter((child) => child.commit);
      const merged = await reconcileChangeSets({
        repository: top, baseCommit: state.baseCommit,
        branches: children.map((child) => ({ role: child.role, branch: child.branch })),
        targetBranch: integrationBranch, identity: this.#worktrees.identity,
      });
      if (merged.status === "escalated") {
        state.escalation = { reason: "merge_conflict", stage: "integration_test", role: merged.conflict.role, conflict: merged.conflict, overlaps: merged.overlaps };
        return { status: "escalated", evidence: { escalation: state.escalation, steps: merged.steps } };
      }
      const path = (await this.#directory(taskId, "integration")) ?? join(this.#worktrees.rootDirectory, taskId, "integration");
      const handle = await this.#worktrees.checkout({ branch: integrationBranch, path });
      state.integration = { branch: integrationBranch, commit: merged.commit, path: handle.path, overlaps: merged.overlaps };
      const results = await this.#runChecks("integration", handle.path, state.commands);
      state.integrationResults = results;
      return {
        status: results.every((result) => result.passed) ? "passed" : "failed",
        evidence: { branch: integrationBranch, commit: merged.commit, steps: merged.steps, overlaps: merged.overlaps, requiresReview: merged.requiresReview, results },
      };
    });

    await stage("prepare_pr", async () => {
      const diff = await diffStats(top, state.baseCommit, state.integration.commit);
      const allChecks = [...state.checkResults, ...state.integrationResults];
      state.mergePolicy = evaluateMergePolicy(mergePolicy, allChecks, { regressed: allChecks.some((check) => !check.passed) });
      const payload = buildPullRequestPayload({
        taskId, objective, acceptanceCriteria: state.acceptanceCriteria, head: state.integration.branch, base: state.baseBranch, diff,
        checks: state.checkResults, integrationChecks: state.integrationResults, reviewFindings: state.reviewFindings,
        securityFindings: state.securityFindings, overlaps: state.integration.overlaps, mergePolicy: state.mergePolicy,
      });
      state.pullRequest = { payload, created: null };
      return { status: "passed", evidence: { title: payload.title, head: payload.head, base: payload.base, diff: diff.totals, mergePolicy: state.mergePolicy } };
    });

    await stage("request_review", async () => {
      if (typeof this.#createPullRequest !== "function") {
        return { status: "skipped", evidence: { reason: "No createPullRequest adapter; the payload is ready for a human to open." } };
      }
      state.pullRequest.created = await submitPullRequest(state.pullRequest.payload, this.#createPullRequest);
      return { status: "passed", evidence: { pullRequest: state.pullRequest.created, reviewRequested: true } };
    });

    const stoppedStage = stages.find((item) => STOPPING.has(item.status));
    return {
      taskId,
      status: stoppedStage ? stoppedStage.status : "awaiting_human_review",
      stoppedAt: stoppedStage?.name ?? null,
      stages,
      branches: state.children.map((child) => ({ role: child.role, branch: child.branch, commit: child.commit })),
      integration: state.integration,
      pullRequest: state.pullRequest,
      mergePolicy: state.mergePolicy ?? evaluateMergePolicy(mergePolicy, [], { blocked: Boolean(stoppedStage) }),
      escalation: state.escalation,
      merged: false,
    };
  }

  /** Removes this task's worktrees (branches are kept for review unless asked). */
  async cleanup(taskId, { deleteBranches = false } = {}) {
    for (const entry of await this.#worktrees.list({ taskId })) {
      await this.#worktrees.remove({ path: entry.path, deleteBranch: deleteBranches });
    }
    for (const [key, path] of this.#prepared) {
      if (!key.startsWith(`${taskId}/`)) continue;
      await this.#runner.releaseDirectory?.(path);
      this.#prepared.delete(key);
    }
  }
}
