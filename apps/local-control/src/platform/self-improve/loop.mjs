import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { addedLines, diffStats, git, resolveCommit } from "../engineering/git.mjs";
import { detectRepositoryCommands, judgeCheck } from "../engineering/pipeline.mjs";
import { ReviewRecovery, RecoveryError } from "./recovery.mjs";
import { WorktreeManager, realOrResolved } from "../engineering/worktrees.mjs";
import { evaluateChange } from "./policy.mjs";
import { backlogCandidates, failingCheckCandidates, selectTask, todoCommentCandidates } from "./selector.mjs";

/**
 * "Atlas, improve yourself": one bounded self-improvement per iteration.
 *
 *   baseline checks → choose one task (and say why) → isolated worktree →
 *   builder edits, verifies and repairs → re-run checks → self-modification
 *   policy → independent reviewer → patch + branch for approval, or abandon
 *
 * - Isolation: every attempt works in its own git worktree on
 *   `atlas/self-<id>/builder`, created from the checkout's HEAD. The
 *   operator's checkout, and the running Atlas, are never written.
 * - Nothing merges. An accepted change is a commit on its branch plus a
 *   portable patch under `patchesDirectory`, waiting for a person (or the
 *   publishing adapters) to take it further. A rejected one is removed,
 *   worktree and branch. Verified candidates survive unavailable review.
 * - Acceptance needs all three: every check passes after the change, the
 *   policy (policy.mjs) allows it, and the reviewer (a separate model call)
 *   approves it. The builder's own report is recorded but never consulted.
 * - Every iteration is appended to a JSONL ledger: what was chosen and why,
 *   what happened, and the current streak of consecutive accepted changes,
 *   which is the measure of whether Atlas can really build Atlas.
 *
 * The builder, check runner and reviewer are injected, so the same loop runs
 * a local Ollama model, a hosted one, or fakes in tests.
 */

const MAX_SCAN_FILES = 3_000;
const MAX_SCAN_BYTES = 200_000;

export class SelfImprovementLoop {
  /**
   * @param {{
   *   repository: string,
   *   worktreeRoot: string,
   *   ledgerPath: string,
   *   patchesDirectory: string,
   *   verifyDirectory?: string,
   *   prepare?: string[][],
   *   builder: (input: { worktree: string, objective: string, verifyDirectory: string }) => Promise<{ ok: boolean, summary?: string }>,
   *   runCheck: (argv: string[], cwd: string) => Promise<{ exitCode: number|null, stdout?: string, stderr?: string, timedOut?: boolean }>,
   *   reviewer: (input: { objective: string, diff: string, checks: object[] }) => Promise<{ approve: boolean, summary: string, concerns: string[] }>,
   *   limits?: object,
   *   now?: () => Date,
   *   log?: (line: string) => void,
   * }} options
   */
  constructor(options) {
    this.options = { verifyDirectory: ".", prepare: [], limits: {}, now: () => new Date(), log: () => {}, ...options };
    this.worktrees = new WorktreeManager({ repository: options.repository, rootDirectory: options.worktreeRoot });
    this.recovery = new ReviewRecovery(join(dirname(options.ledgerPath), "review-recovery"));
  }

  history() {
    if (!existsSync(this.options.ledgerPath)) return [];
    return readFileSync(this.options.ledgerPath, "utf8").split("\n").filter(Boolean).map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
  }

  /** Consecutive accepted iterations at the end of the ledger (idle runs do not break it). */
  streak(history = this.history()) {
    let count = 0;
    for (const entry of [...history].reverse()) {
      if (entry.outcome === "idle") continue;
      if (entry.outcome !== "accepted") break;
      count += 1;
    }
    return count;
  }

  #record(entry) {
    mkdirSync(dirname(this.options.ledgerPath), { recursive: true });
    const history = this.history();
    const record = { ...entry, streak: entry.outcome === "accepted" ? this.streak(history) + 1 : entry.outcome === "idle" ? this.streak(history) : 0 };
    appendFileSync(this.options.ledgerPath, `${JSON.stringify(record)}\n`);
    return record;
  }

  async #checks(worktree) {
    const cwd = join(worktree, this.options.verifyDirectory);
    for (const argv of this.options.prepare) {
      const prepared = await this.options.runCheck(argv, cwd);
      if (prepared.exitCode !== 0) return { error: `Preparing the checkout failed: ${argv.join(" ")} exited ${prepared.exitCode}.`, checks: [] };
    }
    let packageJson = null;
    try { packageJson = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")); } catch { /* no package.json */ }
    const files = (await git(cwd, ["ls-files"])).stdout.split("\n").filter(Boolean);
    const { checks: commands } = detectRepositoryCommands(files, packageJson);
    const checks = [];
    for (const command of commands) {
      const outcome = await this.options.runCheck(command.argv, cwd);
      const verdict = judgeCheck(command.kind, { exitCode: outcome.exitCode, timedOut: outcome.timedOut, stdout: outcome.stdout, stderr: outcome.stderr });
      checks.push({ kind: command.kind, argv: command.argv, passed: verdict.passed, reasons: verdict.reasons, testCounts: verdict.testCounts, output: `${outcome.stdout ?? ""}\n${outcome.stderr ?? ""}`.slice(-4000) });
    }
    return { checks };
  }

  async #candidates(worktree, baselineChecks) {
    const files = (await git(worktree, ["ls-files"])).stdout.split("\n").filter(Boolean).slice(0, MAX_SCAN_FILES);
    const sources = [];
    for (const path of files) {
      const full = join(worktree, path);
      try {
        if (statSync(full).size > MAX_SCAN_BYTES) continue;
        sources.push({ path, text: readFileSync(full, "utf8") });
      } catch { /* unreadable: skip */ }
    }
    const todo = sources.find((file) => file.path === "TODO.md")?.text ?? "";
    return [...failingCheckCandidates(baselineChecks), ...todoCommentCandidates(sources), ...backlogCandidates(todo)];
  }

  /** One self-improvement attempt. Returns the ledger record. */
  async runIteration() {
    const { log, now } = this.options;
    const id = `self-${now().toISOString().replace(/[-:TZ.]/gu, "").slice(0, 14)}-${Math.random().toString(36).slice(2, 6)}`;
    const handle = await this.worktrees.create({ taskId: id, agentRole: "builder" });
    const base = handle.baseCommit;
    const cleanup = async () => { await this.worktrees.remove({ path: handle.path, deleteBranch: true }).catch(() => {}); };
    const started = now().toISOString();
    let release = null;
    let retained = false;
    try {
      log(`[${id}] baseline checks on ${base.slice(0, 10)}…`);
      const baseline = await this.#checks(handle.path);
      if (baseline.error) {
        await cleanup();
        return this.#record({ id, at: started, base, outcome: "error", reason: baseline.error });
      }
      const { task, reason } = selectTask(await this.#candidates(handle.path, baseline.checks), this.history());
      if (!task) {
        await cleanup();
        log(`[${id}] nothing to do: ${reason}`);
        return this.#record({ id, at: started, base, outcome: "idle", reason });
      }
      log(`[${id}] chose ${task.kind} ${task.id}: ${reason}`);
      const objective = `${task.objective}\n\nContext:\n${task.evidence}`.slice(0, 3900);

      // Attempts on the same candidate escalate the model (see agent/models/difficulty.mjs).
      const attempt = this.history().filter((entry) => entry.candidateId === task.id).length + 1;
      const built = await this.options.builder({ worktree: handle.path, objective, verifyDirectory: this.options.verifyDirectory, task: { kind: task.kind, attempt } });
      const head = await this.worktrees.commitAll(handle, `Atlas self-improvement: ${task.kind} ${task.id}`);
      const base_ = { id, at: started, base, candidateId: task.id, kind: task.kind, objective: task.objective, reason, builder: { ok: built.ok, summary: String(built.summary ?? "").slice(0, 1000), ...(built.model ? { model: built.model, difficulty: built.difficulty } : {}) } };
      if (!head) {
        await cleanup();
        return this.#record({ ...base_, outcome: "rejected", violations: [{ rule: "empty", detail: "The builder made no change." }] });
      }

      log(`[${id}] re-running checks after the change…`);
      const after = await this.#checks(handle.path);
      const stats = await diffStats(handle.path, base, head);
      const added = await addedLines(handle.path, base, head);
      const deletedFiles = (await git(handle.path, ["diff", "--name-only", "--diff-filter=D", base, head])).stdout.split("\n").filter(Boolean);
      const count = (checks) => checks.filter((check) => check.testCounts).reduce((sum, check) => sum + check.testCounts.tests, 0) || null;
      const policy = evaluateChange({ stats, added, deletedFiles, testsBefore: count(baseline.checks), testsAfter: count(after.checks), limits: this.options.limits });
      const failing = after.error ? [{ rule: "checks", detail: after.error }] : after.checks.filter((check) => !check.passed).map((check) => ({ rule: "check-failed", detail: `${check.kind}: ${check.reasons.join("; ")}` }));
      const summary = { files: stats.totals.files, added: stats.totals.added, deleted: stats.totals.deleted };
      const checks = after.checks.map(({ kind, passed, reasons, testCounts }) => ({ kind, passed, reasons, testCounts }));

      if (!policy.allowed || failing.length) {
        await cleanup();
        log(`[${id}] rejected: ${[...failing, ...policy.violations].map((item) => item.detail).join(" | ")}`);
        return this.#record({ ...base_, head, outcome: "rejected", stats: summary, checks, violations: [...failing, ...policy.violations] });
      }

      log(`[${id}] checks and policy pass; asking the independent reviewer…`);
      release = this.recovery.lock(id);
      const checkpoint = { id, at: started, base, head, branch: handle.branch, record: { ...base_, builder: { ok: built.ok } }, baselineTests: count(baseline.checks), stats: summary, checks };
      await this.#validateRecovery(checkpoint);
      this.recovery.write(checkpoint);
      retained = true;
      return await this.#review(checkpoint, after.checks);

    } catch (error) {
      if (retained) return this.#waiting(this.recovery.read(id));
      await cleanup();
      return this.#record({ id, at: started, base, outcome: "error", reason: error instanceof Error ? error.message.slice(0, 500) : "unknown error" });
    } finally { release?.(); }
  }

  recoveries() {
    const finished = new Set(this.history().filter(entry => ["accepted", "rejected", "discarded"].includes(entry.outcome)).map(entry => entry.id));
    return this.recovery.list().filter(entry => !finished.has(entry.id)).map(entry => ({ id: entry.id, at: entry.at, objective: entry.record.objective, branch: entry.branch, state: "awaiting_review", reason: "Verified work retained. Retry checks and independent review when the blocker is resolved." }));
  }

  #waiting(checkpoint) {
    return this.#record({ ...checkpoint.record, head: checkpoint.head, branch: checkpoint.branch, outcome: "awaiting_review", reason: "Independent review or verification could not finish. The candidate is retained for retry." });
  }

  async #validateRecovery(checkpoint) {
    if (!/^[0-9a-f]{40}$/u.test(checkpoint.base) || !/^[0-9a-f]{40}$/u.test(checkpoint.head) || checkpoint.branch !== `atlas/${checkpoint.id}/builder`) throw new RecoveryError("Invalid recovery identity.");
    const path = realOrResolved(join(this.options.worktreeRoot, checkpoint.id, "builder"));
    const entry = (await this.worktrees.list({ taskId: checkpoint.id })).find(item => item.branch === checkpoint.branch && realOrResolved(item.path) === path);
    if (!entry || entry.prunable || await resolveCommit(path, "HEAD") !== checkpoint.head) throw new RecoveryError("The retained worktree is missing or changed. No recovery was started.");
    if ((await git(path, ["status", "--porcelain"])).stdout.trim()) throw new RecoveryError("The retained worktree has changed files. No recovery was started.");
    const ancestor = await git(path, ["merge-base", "--is-ancestor", checkpoint.base, checkpoint.head], { okCodes: [0, 1] });
    if (ancestor.code !== 0) throw new RecoveryError("The retained candidate no longer matches its base.");
    return { ...entry, path, baseCommit: checkpoint.base };
  }

  async #review(checkpoint, checks) {
    const handle = await this.#validateRecovery(checkpoint);
    const diff = (await git(handle.path, ["diff", "--no-color", checkpoint.base, checkpoint.head])).stdout;
    const verdict = await this.options.reviewer({ objective: checkpoint.record.objective, diff, checks });
    await this.#validateRecovery(checkpoint);
    if (!verdict.approve) {
      const result = this.#record({ ...checkpoint.record, head: checkpoint.head, outcome: "rejected", stats: checkpoint.stats, checks: checkpoint.checks, review: verdict, violations: [{ rule: "review", detail: verdict.summary || "not approved" }] });
      this.recovery.remove(checkpoint.id);
      await this.worktrees.remove({ path: handle.path, deleteBranch: true }).catch(() => {});
      return result;
    }
    mkdirSync(this.options.patchesDirectory, { recursive: true });
    const patchPath = join(this.options.patchesDirectory, `${checkpoint.id}.patch`);
    writeFileSync(patchPath, (await git(handle.path, ["format-patch", "--stdout", `${checkpoint.base}..${checkpoint.head}`])).stdout, { mode: 0o600 });
    const result = this.#record({ ...checkpoint.record, head: checkpoint.head, outcome: "accepted", branch: checkpoint.branch, patch: patchPath, stats: checkpoint.stats, checks: checkpoint.checks, review: verdict });
    this.recovery.remove(checkpoint.id);
    await this.worktrees.remove({ path: handle.path, deleteBranch: false }).catch(() => {});
    this.options.log(`[${checkpoint.id}] accepted: ${checkpoint.branch}; patch ${patchPath}`);
    return result;
  }

  async retryReview(id) {
    const release = this.recovery.lock(id);
    try {
      if (!this.recoveries().some(entry => entry.id === id)) throw new RecoveryError("No recoverable candidate with that id.");
      const checkpoint = this.recovery.read(id);
      const handle = await this.#validateRecovery(checkpoint);
      const after = await this.#checks(handle.path);
      const stats = await diffStats(handle.path, checkpoint.base, checkpoint.head);
      const deletedFiles = (await git(handle.path, ["diff", "--name-only", "--diff-filter=D", checkpoint.base, checkpoint.head])).stdout.split("\n").filter(Boolean);
      const count = after.checks.filter(check => check.testCounts).reduce((sum, check) => sum + check.testCounts.tests, 0) || null;
      const policy = evaluateChange({ stats, added: await addedLines(handle.path, checkpoint.base, checkpoint.head), deletedFiles, testsBefore: checkpoint.baselineTests, testsAfter: count, limits: this.options.limits });
      if (after.error || after.checks.some(check => !check.passed) || !policy.allowed) return this.#waiting(checkpoint);
      checkpoint.checks = after.checks.map(({ kind, passed, reasons, testCounts }) => ({ kind, passed, reasons, testCounts }));
      this.recovery.write(checkpoint);
      try { return await this.#review(checkpoint, after.checks); }
      catch { return this.#waiting(checkpoint); }
    } finally { release(); }
  }

  async discardRecovery(id) {
    const release = this.recovery.lock(id);
    try {
      if (!this.recoveries().some(entry => entry.id === id)) throw new RecoveryError("No recoverable candidate with that id.");
      const checkpoint = this.recovery.read(id);
      const handle = await this.#validateRecovery(checkpoint);
      await this.worktrees.remove({ path: handle.path, deleteBranch: true });
      this.#record({ ...checkpoint.record, outcome: "discarded", reason: "Discarded by the owner." });
      this.recovery.remove(id);
    } finally { release(); }
  }

  /** Up to `iterations` attempts; stops early when there is nothing left to do. */
  async run({ iterations = 1 } = {}) {
    const results = [];
    for (let index = 0; index < iterations; index += 1) {
      const record = await this.runIteration();
      results.push(record);
      if (["idle", "awaiting_review"].includes(record.outcome)) break;
    }
    return { results, streak: this.streak() };
  }
}

/** The current checkout's HEAD, for callers that want to show it. */
export async function currentHead(repository) {
  return resolveCommit(repository, "HEAD");
}
