import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import * as engineering from "../src/platform/engineering/index.mjs";
import * as pullRequestModule from "../src/platform/engineering/pull-request.mjs";
import * as pipelineModule from "../src/platform/engineering/pipeline.mjs";

const {
  EngineeringWorkflow, WorktreeManager, WorktreeError, agentBranchName, isProtectedBranch, createOwnershipPlan, OwnershipError,
  globsIntersect, matchesGlob, checkChangeSet, detectChangeSetConflicts, reconcileChangeSets, parseTestCounts, judgeCheck,
  detectRepositoryCommands, submitPullRequest, evaluateMergePolicy, HUMAN_REVIEW_REQUIRED, scanSecrets,
} = engineering;

const git = (cwd, ...args) => {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout;
};

const FAKE_TOKEN = `ghp_${"A1b2C3d4E5".repeat(4)}`;

/** A tiny package with a node:test suite, committed on `main`. */
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "atlas-engineering-"));
  const checkout = join(directory, "checkout");
  git(directory, "init", "--quiet", "--initial-branch=main", "checkout");
  git(checkout, "config", "user.email", "operator@example.invalid");
  git(checkout, "config", "user.name", "Operator");
  const files = {
    "package.json": `${JSON.stringify({ name: "fixture", version: "1.0.0", type: "module", scripts: { test: "node --test" } }, null, 2)}\n`,
    "src/api/math.mjs": "export function add(a, b) {\n  return a + b;\n}\n",
    "src/ui/label.mjs": "export const label = (value) => `Total: ${value}`;\n",
    "test/math.test.mjs": [
      'import assert from "node:assert/strict";',
      'import test from "node:test";',
      'import { add } from "../src/api/math.mjs";',
      "",
      'test("add", () => assert.equal(add(2, 3), 5));',
      "",
    ].join("\n"),
  };
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(checkout, path, ".."), { recursive: true });
    await writeFile(join(checkout, path), content, "utf8");
  }
  git(checkout, "add", "-A");
  git(checkout, "commit", "--quiet", "-m", "Initial commit");
  const head = git(checkout, "rev-parse", "HEAD").trim();
  t.after(async () => {
    spawnSync("git", ["worktree", "prune"], { cwd: checkout });
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, checkout, head, work: join(directory, "work") };
}

function assertCheckoutUntouched(checkout, head) {
  assert.equal(git(checkout, "status", "--porcelain").trim(), "", "the operator's checkout is still clean");
  assert.equal(git(checkout, "rev-parse", "HEAD").trim(), head, "the operator's HEAD did not move");
  assert.equal(git(checkout, "symbolic-ref", "--short", "HEAD").trim(), "main");
}

const standardPlan = (extra = {}) => createOwnershipPlan({
  assignments: [
    { role: "backend", paths: ["src/api/**"] },
    { role: "frontend", paths: ["src/ui/**"] },
    { role: "testing", paths: ["test/**"], dependsOn: ["backend"] },
    { role: "deployment", paths: [".github/**", "deploy/**"] },
  ],
  shared: ["package.json"],
  ...extra,
});

/** A fake GitHub client: records PR creations and would record merges. */
function fakeGitHub() {
  const created = [];
  const merges = [];
  return {
    created,
    merges,
    createPullRequest: async (payload) => { created.push(payload); return { url: "https://example.invalid/pr/7", number: 7, state: "open" }; },
    mergePullRequest: async (...args) => { merges.push(args); return { merged: true }; },
  };
}

const edit = async (worktree, path, transform) => {
  const file = join(worktree, path);
  const before = existsSync(file) ? await readFile(file, "utf8") : "";
  await mkdir(join(file, ".."), { recursive: true });
  await writeFile(file, transform(before), "utf8");
};

// ---------------------------------------------------------------------------

test("happy path: children code on their own branches, checks pass, PR payload prepared, nothing merged", async (t) => {
  const { checkout, head, work } = await fixture(t);
  const github = fakeGitHub();
  const seenWorktrees = [];
  const workflow = new EngineeringWorkflow({
    repository: checkout,
    workDirectory: work,
    ownership: standardPlan(),
    createPullRequest: github.createPullRequest,
    coders: {
      backend: async ({ worktree, branch }) => {
        seenWorktrees.push(worktree);
        assert.equal(branch, "atlas/task-1/backend");
        await edit(worktree, "src/api/math.mjs", (text) => `${text}\nexport function multiply(a, b) {\n  return a * b;\n}\n`);
        return "I added multiply and everything definitely works."; // prose: recorded, never trusted
      },
      testing: async ({ worktree }) => {
        seenWorktrees.push(worktree);
        // Starts from the backend's work because it declared the dependency.
        assert.match(await readFile(join(worktree, "src/api/math.mjs"), "utf8"), /multiply/);
        await edit(worktree, "test/multiply.test.mjs", () => [
          'import assert from "node:assert/strict";',
          'import test from "node:test";',
          'import { multiply } from "../src/api/math.mjs";',
          'test("multiply", () => assert.equal(multiply(4, 5), 20));',
          "",
        ].join("\n"));
      },
    },
  });

  const result = await workflow.run({
    taskId: "task-1",
    objective: "Add a multiply function",
    acceptanceCriteria: ["multiply(a, b) returns the product", "existing tests keep passing"],
    mergePolicy: "none", // even the most permissive policy never merges here
  });

  assert.equal(result.status, "awaiting_human_review", JSON.stringify(result.stages.filter((s) => s.status !== "passed"), null, 2));
  assert.deepEqual(result.stages.map((s) => s.name), [...engineering.STAGES]);
  assert.equal(result.merged, false);
  assert.equal(result.mergePolicy.result, HUMAN_REVIEW_REQUIRED);
  assert.equal(result.mergePolicy.mergeActionAvailable, false);
  assert.equal(result.mergePolicy.policyDecision, "merge-now", "the existing merge-decision logic is consulted and reported");

  // Worktrees were used, never the checkout; the checkout is untouched.
  for (const path of seenWorktrees) assert.ok(!path.startsWith(checkout), "coder ran outside the checkout");
  assertCheckoutUntouched(checkout, head);
  assert.equal(existsSync(join(checkout, "test/multiply.test.mjs")), false);

  // Checks ran through the terminal controller; success came from exit codes and counts.
  const checks = result.stages.find((s) => s.name === "checks").evidence.results;
  assert.equal(checks.length, 2);
  for (const check of checks) {
    assert.equal(check.exitCode, 0);
    assert.ok(check.testCounts.tests >= 1 && check.testCounts.fail === 0, JSON.stringify(check));
  }
  const integration = result.stages.find((s) => s.name === "integration_test").evidence;
  assert.equal(integration.results[0].testCounts.pass, 2);
  assert.equal(integration.branch, "atlas/task-1/integration");
  const code = result.stages.find((s) => s.name === "code").evidence.children;
  assert.match(code[0].unverifiedCoderReport, /definitely works/);

  // PR payload + fake adapter: one creation, zero merges.
  assert.equal(github.created.length, 1);
  assert.equal(github.merges.length, 0);
  const payload = github.created[0];
  assert.equal(payload.head, "atlas/task-1/integration");
  assert.equal(payload.base, "main");
  assert.match(payload.body, /multiply\(a, b\) returns the product/);
  assert.match(payload.body, /\| integration \| `npm test --silent` \| 0 \| 2\/2 pass, 0 fail \| passed \|/);
  assert.ok(!("merge" in payload) && !("autoMerge" in payload));
  assert.equal(result.pullRequest.created.number, 7);

  // Main never received the change; the branches exist for review.
  assert.equal(git(checkout, "rev-parse", "main").trim(), head);
  assert.match(git(checkout, "branch", "--list", "atlas/*"), /atlas\/task-1\/integration/);

  await workflow.cleanup("task-1");
  assert.deepEqual(await workflow.worktrees.list({ taskId: "task-1" }), []);
  assertCheckoutUntouched(checkout, head);
});

test("no merge operation exists anywhere in the engineering modules", () => {
  const exported = [...Object.keys(engineering), ...Object.keys(pullRequestModule), ...Object.keys(pipelineModule)];
  assert.deepEqual(exported.filter((name) => /merge(?!Policy)/i.test(name) && !/^evaluateMergePolicy$/.test(name)), []);
  const methods = Object.getOwnPropertyNames(EngineeringWorkflow.prototype);
  assert.deepEqual(methods.filter((name) => /merge|push|approve/i.test(name)), []);
  const policy = evaluateMergePolicy("ci-gated", [{ passed: true }]);
  assert.equal(policy.result, HUMAN_REVIEW_REQUIRED);
  assert.equal(policy.policyDecision, "merge-now");
});

test("a failing test fails the workflow with exit code and counts as evidence; no PR is requested", async (t) => {
  const { checkout, head, work } = await fixture(t);
  const github = fakeGitHub();
  const workflow = new EngineeringWorkflow({
    repository: checkout, workDirectory: work, ownership: standardPlan(), createPullRequest: github.createPullRequest,
    coders: {
      backend: async ({ worktree }) => {
        await edit(worktree, "src/api/math.mjs", (text) => text.replace("a + b", "a - b"));
        return { ok: true, summary: "All tests pass." };
      },
    },
  });
  const result = await workflow.run({ taskId: "task-2", objective: "Refactor add", acceptanceCriteria: ["add still adds"] });
  assert.equal(result.status, "failed");
  assert.equal(result.stoppedAt, "checks");
  const [check] = result.stages.find((s) => s.name === "checks").evidence.results;
  assert.notEqual(check.exitCode, 0);
  assert.equal(check.passed, false);
  assert.equal(check.testCounts.fail, 1);
  assert.match(check.stdout, /add/);
  for (const name of ["diff_review", "security_scan", "integration_test", "prepare_pr", "request_review"]) {
    assert.equal(result.stages.find((s) => s.name === name).status, "not_run");
  }
  assert.equal(github.created.length, 0);
  assert.equal(github.merges.length, 0);
  assert.equal(result.mergePolicy.result, HUMAN_REVIEW_REQUIRED);
  await workflow.cleanup("task-2", { deleteBranches: true });
  assertCheckoutUntouched(checkout, head);
});

test("acceptance criteria are required", async (t) => {
  const { checkout, work } = await fixture(t);
  const workflow = new EngineeringWorkflow({ repository: checkout, workDirectory: work, ownership: standardPlan(), coders: { backend: async () => {} } });
  for (const criteria of [undefined, [], ["  "]]) {
    const result = await workflow.run({ taskId: "task-ac", objective: "x", acceptanceCriteria: criteria });
    assert.equal(result.status, "failed");
    assert.equal(result.stoppedAt, "acceptance_criteria");
  }
  assert.deepEqual(await workflow.worktrees.list(), []);
});

test("overlapping ownership is detected and stops the plan", async (t) => {
  const plan = createOwnershipPlan({
    assignments: [
      { role: "frontend", paths: ["src/**"] },
      { role: "backend", paths: ["src/api/**", "server/"] },
      { role: "database", paths: ["db/*.sql"] },
    ],
  });
  assert.deepEqual(plan.overlaps.map((o) => o.roles), [["frontend", "backend"]]);
  assert.equal(globsIntersect("src/*.mjs", "src/**/index.*"), true);
  assert.equal(globsIntersect("src/*.mjs", "src/api/*.mjs"), false);
  assert.equal(globsIntersect("db/*.sql", "db/migrations/**"), false);
  assert.equal(globsIntersect("**/*.test.mjs", "test/**"), true);
  assert.equal(matchesGlob("src/**/x.js", "src/x.js"), true);
  assert.equal(matchesGlob("src/*", "src/a/b"), false);

  const { checkout, work } = await fixture(t);
  const workflow = new EngineeringWorkflow({ repository: checkout, workDirectory: work, ownership: plan, coders: { frontend: async () => {} } });
  const result = await workflow.run({ taskId: "task-3", objective: "x", acceptanceCriteria: ["y"] });
  assert.equal(result.status, "failed");
  assert.equal(result.stoppedAt, "plan");
  assert.equal(result.stages.find((s) => s.name === "plan").evidence.overlaps.length, 1);
});

test("dependency ordering is topological and cycles are refused", () => {
  const plan = createOwnershipPlan({
    assignments: [
      { role: "testing", paths: ["test/**"], dependsOn: ["backend", "frontend"] },
      { role: "frontend", paths: ["web/**"], dependsOn: ["backend"] },
      { role: "backend", paths: ["api/**"], dependsOn: ["database"] },
      { role: "database", paths: ["db/**"] },
    ],
  });
  assert.deepEqual(plan.order, ["database", "backend", "frontend", "testing"]);
  assert.throws(() => createOwnershipPlan({ assignments: [
    { role: "frontend", paths: ["a/**"], dependsOn: ["backend"] },
    { role: "backend", paths: ["b/**"], dependsOn: ["frontend"] },
  ] }), (error) => error instanceof OwnershipError && error.code === "DEPENDENCY_CYCLE");
  assert.throws(() => createOwnershipPlan({ assignments: [{ role: "wizard", paths: ["x"] }] }), /not an engineering child role/);
  const check = checkChangeSet(createOwnershipPlan({ assignments: [{ role: "backend", paths: ["api/**"] }, { role: "frontend", paths: ["web/**"] }], shared: ["package.json"] }), "backend", ["api/a.mjs", "package.json", "web/x.mjs"]);
  assert.deepEqual(check.owned, ["api/a.mjs"]);
  assert.deepEqual(check.shared, ["package.json"]);
  assert.deepEqual(check.violations, [{ path: "web/x.mjs", owners: ["frontend"] }]);
  assert.deepEqual(detectChangeSetConflicts([{ role: "a", files: ["x", "y"] }, { role: "b", files: ["y"] }]), [{ path: "y", roles: ["a", "b"] }]);
});

test("conflicting edits by two children escalate instead of being auto-resolved", async (t) => {
  const { checkout, head, work } = await fixture(t);
  const github = fakeGitHub();
  const bump = (version) => (text) => text.replace('"version": "1.0.0"', `"version": "${version}"`);
  const workflow = new EngineeringWorkflow({
    repository: checkout, workDirectory: work, ownership: standardPlan(), createPullRequest: github.createPullRequest,
    coders: {
      backend: async ({ worktree }) => { await edit(worktree, "package.json", bump("1.1.0")); },
      frontend: async ({ worktree }) => { await edit(worktree, "package.json", bump("2.0.0")); },
    },
  });
  const result = await workflow.run({ taskId: "task-4", objective: "Bump version", acceptanceCriteria: ["version bumped"] });
  assert.equal(result.status, "escalated");
  assert.equal(result.stoppedAt, "integration_test");
  assert.equal(result.escalation.reason, "merge_conflict");
  assert.deepEqual(result.escalation.conflict.files, ["package.json"]);
  assert.deepEqual(result.escalation.overlaps, [{ path: "package.json", roles: ["backend", "frontend"] }]);
  assert.equal(github.created.length, 0);
  assert.equal(git(checkout, "branch", "--list", "atlas/task-4/integration").trim(), "", "no integration branch was written");
  await workflow.cleanup("task-4", { deleteBranches: true });
  assertCheckoutUntouched(checkout, head);
});

test("clean edits to the same file merge three-way and are marked for review", async (t) => {
  const { checkout, head, work } = await fixture(t);
  const manager = new WorktreeManager({ repository: checkout, rootDirectory: work });
  const a = await manager.create({ taskId: "t5", agentRole: "backend" });
  const b = await manager.create({ taskId: "t5", agentRole: "frontend" });
  await edit(a.path, "src/api/math.mjs", (text) => `// header\n${text}`);
  await edit(b.path, "src/api/math.mjs", (text) => `${text}// footer\n`);
  await manager.commitAll(a, "a");
  await manager.commitAll(b, "b");
  const merged = await reconcileChangeSets({
    repository: checkout, baseCommit: head, targetBranch: "atlas/t5/integration",
    branches: [{ role: "backend", branch: a.branch }, { role: "frontend", branch: b.branch }],
  });
  assert.equal(merged.status, "merged");
  assert.equal(merged.requiresReview, true);
  const content = git(checkout, "show", `${merged.commit}:src/api/math.mjs`);
  assert.match(content, /^\/\/ header/);
  assert.match(content, /\/\/ footer\n$/);
  await assert.rejects(reconcileChangeSets({ repository: checkout, baseCommit: head, branches: [{ role: "backend", branch: "main" }] }), /protected/);
  for (const entry of await manager.list()) await manager.remove({ path: entry.path, deleteBranch: true });
  assertCheckoutUntouched(checkout, head);
});

test("a forbidden path change is blocked at diff review", async (t) => {
  const { checkout, head, work } = await fixture(t);
  const github = fakeGitHub();
  const workflow = new EngineeringWorkflow({
    repository: checkout, workDirectory: work, ownership: standardPlan(), createPullRequest: github.createPullRequest,
    coders: {
      deployment: async ({ worktree }) => { await edit(worktree, ".github/workflows/ci.yml", () => "on: push\njobs: {}\n"); },
    },
  });
  const result = await workflow.run({ taskId: "task-6", objective: "Add CI", acceptanceCriteria: ["CI exists"] });
  assert.equal(result.status, "blocked");
  assert.equal(result.stoppedAt, "diff_review");
  const review = result.stages.find((s) => s.name === "diff_review").evidence;
  assert.deepEqual(review.forbidden.map((f) => f.path), [".github/workflows/ci.yml"]);
  assert.deepEqual(review.ownershipViolations, []);
  assert.equal(github.created.length, 0);
  await workflow.cleanup("task-6", { deleteBranches: true });
  assertCheckoutUntouched(checkout, head);
});

test("a secret in the diff is blocked and never appears in the evidence", async (t) => {
  const { checkout, head, work } = await fixture(t);
  const github = fakeGitHub();
  const workflow = new EngineeringWorkflow({
    repository: checkout, workDirectory: work, ownership: standardPlan(), createPullRequest: github.createPullRequest,
    coders: {
      backend: async ({ worktree }) => { await edit(worktree, "src/api/client.mjs", () => `export const token = "${FAKE_TOKEN}";\n`); },
    },
  });
  const result = await workflow.run({ taskId: "task-7", objective: "Add client", acceptanceCriteria: ["client exists"] });
  assert.equal(result.status, "blocked");
  assert.equal(result.stoppedAt, "diff_review");
  const review = result.stages.find((s) => s.name === "diff_review").evidence;
  assert.equal(review.secrets.length, 1);
  assert.deepEqual(review.secrets[0].categories, ["github-token"]);
  assert.equal(review.secrets[0].path, "src/api/client.mjs");
  assert.ok(!JSON.stringify(result).includes(FAKE_TOKEN), "the secret value is not in the result");
  assert.equal(github.created.length, 0);
  await workflow.cleanup("task-7", { deleteBranches: true });
  assertCheckoutUntouched(checkout, head);
});

test("child_process additions are flagged by the security scan and surfaced in the PR", async (t) => {
  const { checkout, head, work } = await fixture(t);
  const github = fakeGitHub();
  const calls = [];
  const workflow = new EngineeringWorkflow({
    repository: checkout, workDirectory: work, ownership: standardPlan(), createPullRequest: github.createPullRequest,
    // An injected runner that still runs real commands (without a shell).
    commandRunner: {
      async run({ cwd, argv }) {
        calls.push(argv);
        const env = { PATH: process.env.PATH, HOME: cwd };
        const child = spawnSync(argv[0], argv.slice(1), { cwd, encoding: "utf8", env });
        return { exitCode: child.status, stdout: child.stdout, stderr: child.stderr, timedOut: false };
      },
    },
    coders: {
      backend: async ({ worktree }) => {
        await edit(worktree, "src/api/run.mjs", () => 'import { execFileSync } from "node:child_process";\nexport const version = () => execFileSync("node", ["--version"]);\n');
      },
    },
  });
  const result = await workflow.run({ taskId: "task-8", objective: "Report node version", acceptanceCriteria: ["version() returns output"], checks: [{ kind: "test", argv: ["node", "--test"] }] });
  assert.equal(result.status, "awaiting_human_review");
  const scan = result.stages.find((s) => s.name === "security_scan");
  assert.equal(scan.status, "flagged");
  assert.ok(scan.evidence.findings.some((f) => f.rule === "child-process"));
  assert.match(github.created[0].body, /child-process in `src\/api\/run\.mjs:1`/);
  assert.equal(github.merges.length, 0);
  assert.deepEqual(calls, [["node", "--test"], ["node", "--test"]]);
  await workflow.cleanup("task-8", { deleteBranches: true });
  assertCheckoutUntouched(checkout, head);
});

test("worktree manager refuses protected branches and the checkout itself", async (t) => {
  const { checkout, head, work } = await fixture(t);
  for (const name of ["main", "master", "release", "release/1.2", "refs/heads/main", "HEAD"]) assert.equal(isProtectedBranch(name), true, name);
  assert.equal(isProtectedBranch("atlas/t/backend"), false);
  assert.equal(agentBranchName("t1", "backend"), "atlas/t1/backend");
  assert.throws(() => agentBranchName("../x", "backend"), WorktreeError);
  assert.throws(() => agentBranchName("t1", "a b"), WorktreeError);

  await assert.rejects(new WorktreeManager({ repository: checkout, rootDirectory: join(checkout, "nested") }).create({ taskId: "t9", agentRole: "backend" }), (error) => error.code === "ROOT_INSIDE_CHECKOUT");
  const manager = new WorktreeManager({ repository: checkout, rootDirectory: work });
  const handle = await manager.create({ taskId: "t9", agentRole: "backend" });
  assert.equal(handle.baseCommit, head);
  await assert.rejects(manager.create({ taskId: "t9", agentRole: "backend" }), (error) => error.code === "BRANCH_EXISTS");
  assert.deepEqual((await manager.list()).map((e) => e.branch), ["atlas/t9/backend"]);
  await assert.rejects(manager.remove({ path: checkout }), (error) => error.code === "MAIN_WORKTREE");
  await assert.rejects(manager.deleteBranch("main"), (error) => error.code === "PROTECTED_BRANCH");
  await assert.rejects(manager.checkout({ branch: "main", path: join(work, "x") }), (error) => error.code === "PROTECTED_BRANCH");
  assert.equal(await manager.commitAll(handle, "nothing"), null);
  await manager.remove({ branch: "atlas/t9/backend", deleteBranch: true });
  assert.deepEqual(await manager.list(), []);
  assertCheckoutUntouched(checkout, head);
});

test("check judging uses exit codes and test counts only", () => {
  assert.deepEqual(parseTestCounts("# tests 3\n# pass 2\n# fail 1\n"), { tests: 3, pass: 2, fail: 1, cancelled: 0 });
  assert.deepEqual(parseTestCounts("ℹ tests 4\nℹ pass 4\nℹ fail 0\n"), { tests: 4, pass: 4, fail: 0, cancelled: 0 });
  assert.equal(parseTestCounts("All tests passed!"), null);
  assert.equal(judgeCheck("test", { exitCode: 0, stdout: "# tests 0\n# pass 0\n# fail 0\n" }).passed, false, "zero tests is not success");
  assert.equal(judgeCheck("test", { exitCode: 0, stdout: "# tests 2\n# pass 1\n# fail 1\n" }).passed, false, "failing count overrides exit code");
  assert.equal(judgeCheck("test", { exitCode: 1, stdout: "Everything passed, trust me." }).passed, false);
  assert.equal(judgeCheck("test", { status: "requires_approval", exitCode: null }).passed, false);
  assert.equal(judgeCheck("format", { exitCode: 0, stdout: "" }).passed, true);
  const detected = detectRepositoryCommands(["package.json", "a.test.mjs"], { scripts: { test: "node --test", typecheck: "tsc", lint: "eslint ." } });
  assert.deepEqual(detected.checks.map((c) => c.kind), ["format", "typecheck", "test"]);
  assert.equal(scanSecrets([{ path: "a", line: 1, text: "const x = 1;" }]).length, 0);
});

test("the PR adapter refuses merge requests and adapters that report a merge", async () => {
  const policy = evaluateMergePolicy("manual", []);
  await assert.rejects(submitPullRequest({ title: "x", mergePolicy: policy, autoMerge: true }, async () => ({})), /not allowed/);
  await assert.rejects(submitPullRequest({ title: "x", mergePolicy: { result: "merge" } }, async () => ({})), /human review/);
  await assert.rejects(submitPullRequest({ title: "x", mergePolicy: policy }, async () => ({ merged: true })), /reported a merge/);
  assert.deepEqual(await submitPullRequest({ title: "x", mergePolicy: policy }, async () => ({ html_url: "u", number: 1 })), { url: "u", number: 1, state: "open" });
});
