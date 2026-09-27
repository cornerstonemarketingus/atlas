import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { addedLines, diffStats, git } from "../engineering/git.mjs";
import { evaluateChange } from "../self-improve/policy.mjs";
import { executionOrder } from "./planner.mjs";
import { getTemplate } from "./templates/index.mjs";
import { commitWorkspace, createWorkspace, projectFolderName } from "./workspace.mjs";

/**
 * Carries an approved Genesis project to a verified, running application,
 * using Atlas's existing machinery rather than new versions of it:
 *
 * - scaffolding: workspace.mjs creates the local project from its template
 *   and commits it (git, no remote). A changed project is reconfigured in
 *   place instead.
 * - building: tasks run in dependency order. `template` tasks are satisfied
 *   by the template's configuration and are confirmed only when the checks
 *   pass. `coder` tasks go to Atlas's coder (packages/atlas-cli `code`, via
 *   the injected `coder`), one bounded objective at a time; each result is
 *   committed.
 * - verifying: the template's own check/test/build commands, through the
 *   daemon's shell-free runCheck.
 * - repairing: a failure becomes a bounded repair objective carrying its
 *   evidence. A repair may not delete tests, reduce the number of tests or
 *   add secret-shaped text (the self-improvement change policy); otherwise it
 *   is rolled back. Repairs stop at the project's repair budget.
 * - previewing / reviewing: the injected preview manager starts the app and
 *   the injected inspector checks it; their failures are repaired the same
 *   way. One bounded polish pass follows a clean review when a coder exists.
 *
 * Every step is a lifecycle transition with evidence. Nothing is marked done
 * without a check, and a missing capability (no model for a coder task, no
 * preview, no inspector) stops the project with that reason instead of
 * pretending.
 */

const TAIL = 4_000;
const MAX_STEPS = 60;

export function outputTail(result) {
  return `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim().slice(-TAIL);
}

/** Counts from node:test output ("# tests 12", "# pass 11", "# fail 1"); null when absent. */
export function testSummary(text) {
  const read = (name) => { const match = new RegExp(`^# ${name} (\\d+)`, "mu").exec(String(text)); return match ? Number(match[1]) : null; };
  const tests = read("tests");
  return tests === null ? null : { tests, pass: read("pass"), fail: read("fail") };
}

async function head(folder) {
  return (await git(folder, ["rev-parse", "HEAD"])).stdout.trim();
}

export class GenesisExecutor {
  /**
   * @param {{
   *   genesis: import("./service.mjs").GenesisService,
   *   projectsRoot: string,
   *   runCheck: (argv: string[], cwd: string, options?: object) => Promise<{ exitCode: number, stdout: string, stderr: string, timedOut?: boolean }>,
   *   coder?: ((input: { workspace: string, objective: string, task: object, attempt: number, kind: string }) => Promise<{ ok: boolean, summary: string, model?: string|null }>) | null,
   *   preview?: { start: (project: object) => Promise<{ ok: boolean, url?: string, logs?: string, reason?: string }>, stop?: (projectId: string) => Promise<unknown> } | null,
   *   inspector?: ((project: object, preview: object) => Promise<{ ok: boolean, findings: object[], evidence: object, limited?: boolean }>) | null,
   *   checkTimeoutMs?: number,
   *   log?: (line: string) => void,
   *   now?: () => number,
   * }} options
   */
  constructor({ genesis, projectsRoot, runCheck, coder = null, preview = null, inspector = null, checkTimeoutMs = 600_000, log = () => {}, now = () => Date.now() }) {
    this.genesis = genesis;
    this.store = genesis.store;
    this.tenantId = genesis.tenantId;
    this.projectsRoot = projectsRoot;
    this.runCheck = runCheck;
    this.coder = coder;
    this.preview = preview;
    this.inspector = inspector;
    this.checkTimeoutMs = checkTimeoutMs;
    this.log = log;
    this.now = now;
    this.running = new Map();
  }

  #project(id) { return this.store.get(this.tenantId, id); }
  #tasks(id) { return this.store.tasks(this.tenantId, id); }
  #task(id, taskId, update) { return this.store.updateTask(this.tenantId, id, taskId, update); }

  #move(id, to, reason, evidence = {}, patch = {}) {
    this.log(`${to}: ${reason}`);
    return this.genesis.advance(id, to, { reason, evidence, patch });
  }

  isRunning(id) { return this.running.has(id); }

  /** A coder exists and its model server answers. */
  async #coderReady() {
    if (!this.coder) return false;
    try { return (await this.coder.available?.()) ?? true; } catch { return false; }
  }

  /** Drives the project from its current state until ready, a hold, or failure. One run per project at a time. */
  run(id) {
    if (this.running.has(id)) return this.running.get(id);
    const promise = this.#drive(id).finally(() => this.running.delete(id));
    this.running.set(id, promise);
    return promise;
  }

  async #drive(id) {
    try {
      for (let steps = 0; steps < MAX_STEPS; steps += 1) {
        if (!(await this.#step(this.#project(id)))) return this.genesis.view(id);
      }
      throw new Error(`The build did not settle after ${MAX_STEPS} steps.`);
    } catch (error) {
      const project = this.#project(id);
      if (!["failed", "cancelled", "paused", "blocked", "ready", "published"].includes(project.state)) {
        this.#move(id, "failed", `Stopped by an error: ${error instanceof Error ? error.message : "unknown error"}`, { kind: "error", message: String(error?.stack ?? error).slice(0, 4000) });
      }
      return this.genesis.view(id);
    }
  }

  /** One stage; true when the project moved on and the drive should continue. */
  async #step(project) {
    switch (project.state) {
      case "approved":
      case "scaffolding": return this.#scaffold(project);
      case "building": return this.#build(project);
      case "verifying": return this.#verify(project);
      case "repairing": return this.#repair(project);
      case "previewing": return this.#previewStage(project);
      case "reviewing": return this.#review(project);
      default: return false;
    }
  }

  async #scaffold(project) {
    if (project.state === "approved") this.#move(project.id, "scaffolding", project.workspace ? "Updating the project for the new plan." : "Creating the project on this computer.", { kind: "stage" });
    const scaffoldTask = this.#tasks(project.id).find((task) => task.kind === "scaffold");
    if (scaffoldTask) this.#task(project.id, scaffoldTask.id, { status: "running", attempt: true, evidence: { kind: "start" } });
    let evidence;
    let folder = project.workspace;
    if (folder) {
      // A change request: rewrite the template configuration from the updated spec and commit it.
      const template = getTemplate(project.plan.template);
      for (const [relativePath, content] of Object.entries(template.configure(project.spec))) {
        if (relativePath === "README.md" || relativePath.endsWith(".json")) writeFileSync(join(folder, relativePath), content);
      }
      const commit = await commitWorkspace(folder, `Update configuration for spec v${project.spec.version ?? 1}`);
      evidence = { kind: "workspace", folder, reused: true, commit };
    } else {
      const expected = join(this.projectsRoot, projectFolderName(project.spec.name, project.id));
      const meta = (() => { try { return JSON.parse(readFileSync(join(expected, ".atlas", "genesis.json"), "utf8")); } catch { return null; } })();
      if (meta?.projectId === project.id) {
        // Interrupted after the folder was created: reuse it rather than fail on "already exists".
        folder = expected;
        evidence = { kind: "workspace", folder, reused: true, commit: await head(folder) };
      } else {
        const workspace = await createWorkspace({ root: this.projectsRoot, projectId: project.id, spec: project.spec, templateId: project.plan.template });
        folder = workspace.folder;
        evidence = { kind: "workspace", folder, template: workspace.template, commit: workspace.commit, files: workspace.files.length };
      }
    }
    if (scaffoldTask) this.#task(project.id, scaffoldTask.id, { status: "passed", evidence });
    this.#move(project.id, "building", "Project ready; building the features.", evidence, { workspace: folder });
    return true;
  }

  async #build(project) {
    const tasks = this.#tasks(project.id);
    const byId = new Map(tasks.map((task) => [task.id, task]));
    for (const taskId of executionOrder(tasks)) {
      const task = byId.get(taskId);
      if (task.status === "passed" || task.status === "skipped") continue;
      if (task.executor === "template" && task.kind !== "scaffold") {
        this.#task(project.id, task.id, { status: "running", evidence: { kind: "template", note: `Provided by the ${project.plan.template} template configuration; confirmed by the checks.` } });
        continue;
      }
      if (task.executor === "coder" && task.kind !== "polish") {
        const done = await this.#runCoderTask(project, task);
        if (!done) return false;
      }
    }
    this.#move(project.id, "verifying", "Features in place; running the checks.", { kind: "stage" });
    return true;
  }

  async #runCoderTask(project, task) {
    if (!(await this.#coderReady())) {
      this.#task(project.id, task.id, { status: "blocked", evidence: { kind: "capability", missing: "model" } });
      this.#move(project.id, "blocked", `"${task.title}" needs a coding model. Set one up under Models, then resume.`, { kind: "capability", missing: "model", task: task.id });
      return false;
    }
    for (let attempt = task.attempts + 1; attempt <= 2; attempt += 1) {
      const before = await head(project.workspace);
      this.#task(project.id, task.id, { status: "running", attempt: true, evidence: { kind: "start", attempt } });
      const objective = `${task.objective}\n\nThis is one step of building "${project.spec.name}". Verification for this step: ${task.verification.join("; ")}. Keep existing behaviour and tests working; add tests for what you add.`;
      const result = await this.coder({ workspace: project.workspace, objective, task, attempt, kind: "task" });
      const guard = await this.#guard(project.workspace, before);
      if (!guard.allowed) {
        await git(project.workspace, ["reset", "-q", "--hard", before]);
        this.#task(project.id, task.id, { status: "failed", evidence: { kind: "rejected", attempt, violations: guard.violations } });
        continue;
      }
      const commit = await commitWorkspace(project.workspace, `${task.title} (Atlas, attempt ${attempt})`);
      if (result.ok) {
        this.#task(project.id, task.id, { status: "passed", evidence: { kind: "coder", attempt, model: result.model ?? null, commit, summary: String(result.summary ?? "").slice(-1500) } });
        return true;
      }
      this.#task(project.id, task.id, { status: "failed", evidence: { kind: "coder", attempt, model: result.model ?? null, commit, summary: String(result.summary ?? "").slice(-1500) } });
    }
    this.#move(project.id, "failed", `"${task.title}" could not be completed after 2 attempts.`, { kind: "task", task: task.id });
    return false;
  }

  /** The repair/change policy for a project workspace: tests only grow, nothing secret-shaped. */
  async #guard(folder, base) {
    await git(folder, ["add", "-A"]);
    const status = await git(folder, ["status", "--porcelain"]);
    if (!status.stdout.trim()) return { allowed: true, violations: [] };
    const tree = (await git(folder, ["write-tree"])).stdout.trim();
    const temp = (await git(folder, ["commit-tree", tree, "-p", base, "-m", "guard"], { env: { GIT_AUTHOR_NAME: "Atlas", GIT_AUTHOR_EMAIL: "atlas@users.noreply.invalid", GIT_COMMITTER_NAME: "Atlas", GIT_COMMITTER_EMAIL: "atlas@users.noreply.invalid" } })).stdout.trim();
    const deleted = (await git(folder, ["diff", "--name-only", "--diff-filter=D", base, temp])).stdout.split("\n").filter(Boolean);
    const testsBefore = await countTestsAt(folder, base);
    const testsAfter = await countTestsAt(folder, temp);
    const verdict = evaluateChange({
      stats: await diffStats(folder, base, temp),
      added: await addedLines(folder, base, temp),
      deletedFiles: deleted,
      testsBefore,
      testsAfter,
      limits: { maxFiles: 40, maxChangedLines: 3000, forbidden: [".atlas/**", ".git/**"] },
    });
    // Size limits are for Atlas changing itself; in a generated project only the
    // rules that protect verification and secrets apply.
    const violations = verdict.violations.filter((violation) => ["deleted-test", "fewer-tests", "secret", "forbidden-path"].includes(violation.rule));
    return { allowed: violations.length === 0, violations };
  }

  async #verify(project) {
    const template = getTemplate(project.plan.template);
    const results = [];
    for (const name of ["install", "check", "test", "build"]) {
      const argv = template.commands[name];
      if (!argv) continue;
      const started = this.now();
      const result = await this.runCheck(argv, project.workspace, { timeoutMs: this.checkTimeoutMs });
      const tail = outputTail(result);
      results.push({ name, command: argv.join(" "), exitCode: result.exitCode, timedOut: Boolean(result.timedOut), durationMs: this.now() - started, summary: name === "test" ? testSummary(tail) : null, output: result.exitCode === 0 ? tail.slice(-600) : tail });
      if (result.exitCode !== 0) break;
    }
    const failed = results.find((result) => result.exitCode !== 0);
    const checksTask = this.#tasks(project.id).find((task) => task.executor === "checks");
    if (!failed) {
      const tests = results.find((result) => result.name === "test")?.summary;
      if (checksTask) this.#task(project.id, checksTask.id, { status: "passed", attempt: true, evidence: { kind: "checks", results: results.map(({ output, ...rest }) => rest) } });
      for (const task of this.#tasks(project.id).filter((t) => t.executor === "template" && t.status === "running")) {
        this.#task(project.id, task.id, { status: "passed", evidence: { kind: "verified", by: "checks", tests } });
      }
      this.#move(project.id, "previewing", `All checks passed${tests ? ` (${tests.pass} tests)` : ""}; starting the application.`, { kind: "checks", results: results.map(({ output, ...rest }) => rest) });
      return true;
    }
    if (checksTask) this.#task(project.id, checksTask.id, { status: "failed", attempt: true, evidence: { kind: "checks", failed: failed.name, exitCode: failed.exitCode } });
    return this.#toRepair(project, { stage: "verifying", check: failed.name, command: failed.command, exitCode: failed.exitCode, timedOut: failed.timedOut, summary: failed.summary, output: failed.output });
  }

  async #toRepair(project, failure) {
    const explained = await this.genesis.intelligence.explainFailure({ task: failure.check ?? failure.stage, evidence: failure }).catch(() => ({ summary: "A check failed.", hints: [] }));
    const evidence = { kind: "failure", failure: { ...failure, explanation: explained } };
    if (!(await this.#coderReady())) {
      this.#move(project.id, "failed", `${failure.check ? `The ${failure.check} step` : "Verification"} failed and no coding model is available to repair it. Set one up under Models, then ask Atlas to try again.`, evidence);
      return false;
    }
    if (project.repairsUsed >= project.repairBudget) {
      this.#move(project.id, "failed", `Still failing after ${project.repairsUsed} repair attempt(s): ${explained.summary}`.slice(0, 900), evidence);
      return false;
    }
    this.#move(project.id, "repairing", `Fixing: ${explained.summary}`.slice(0, 900), evidence);
    return true;
  }

  async #repair(project) {
    const transitions = this.store.transitions(this.tenantId, project.id);
    const entry = [...transitions].reverse().find((t) => t.to === "repairing");
    const failure = entry?.evidence?.failure ?? null;
    const polish = entry?.evidence?.kind === "polish";
    const before = await head(project.workspace);
    const objective = polish
      ? `${entry.evidence.task.objective}\n\nBrowser findings to address:\n${JSON.stringify(entry.evidence.findings ?? [], null, 1).slice(0, 3000)}\n\nKeep every test passing. Do not remove features or tests.`
      : [
        `The ${project.spec.name} project has a failing ${failure?.check ?? failure?.stage ?? "check"}${failure?.command ? ` (\`${failure.command}\`)` : ""}. Fix the application code so it passes.`,
        failure?.explanation?.summary ? `Likely cause: ${failure.explanation.summary}` : "",
        failure?.findings ? `Observed in the running app:\n${JSON.stringify(failure.findings, null, 1).slice(0, 2500)}` : "",
        failure?.output ? `Output:\n${String(failure.output).slice(-2500)}` : "",
        "Do not delete or weaken tests, and do not change what the tests expect unless the test itself is wrong.",
      ].filter(Boolean).join("\n\n");
    const result = await this.coder({ workspace: project.workspace, objective, task: { id: polish ? entry.evidence.task.id : "repair", title: polish ? "Polish" : "Repair" }, attempt: project.repairsUsed + 1, kind: polish ? "polish" : "repair" });
    const guard = await this.#guard(project.workspace, before);
    if (!guard.allowed) await git(project.workspace, ["reset", "-q", "--hard", before]);
    const commit = guard.allowed ? await commitWorkspace(project.workspace, polish ? "Polish the interface (Atlas)" : `Repair ${failure?.check ?? "failure"} (Atlas, attempt ${project.repairsUsed + 1})`) : null;
    if (polish) this.#task(project.id, entry.evidence.task.id, { status: guard.allowed ? "passed" : "failed", attempt: true, evidence: { kind: "polish", ok: result.ok, commit, violations: guard.violations, summary: String(result.summary ?? "").slice(-1000) } });
    this.#move(project.id, "verifying", guard.allowed ? `${polish ? "Polish" : "Repair"} applied${commit ? "" : " (no changes)"}; checking again.` : `${polish ? "Polish" : "Repair"} rejected (${guard.violations.map((v) => v.rule).join(", ")}) and rolled back; checking again.`, {
      kind: polish ? "polish-result" : "repair-result", ok: result.ok, commit, model: result.model ?? null, violations: guard.violations, summary: String(result.summary ?? "").slice(-1500),
    }, polish ? {} : { repairsUsed: project.repairsUsed + 1 });
    return true;
  }

  async #previewStage(project) {
    if (!this.preview) {
      this.#move(project.id, "blocked", "The checks pass, but this Atlas cannot start a preview, so the app has not been seen running yet.", { kind: "capability", missing: "preview" });
      return false;
    }
    const started = await this.preview.start(project);
    if (!started.ok) return this.#toRepair(project, { stage: "previewing", check: "preview", reason: started.reason, output: started.logs });
    this.#move(project.id, "reviewing", `Running at ${started.url}; inspecting it.`, { kind: "preview", url: started.url, port: started.port ?? null }, { preview: { url: started.url, port: started.port ?? null, startedAt: new Date(this.now()).toISOString() } });
    return true;
  }

  async #review(project) {
    if (!this.inspector) {
      this.#move(project.id, "blocked", "The app runs, but no browser is available to inspect it.", { kind: "capability", missing: "browser" });
      return false;
    }
    const inspection = await this.inspector(project, project.preview);
    const browserTask = this.#tasks(project.id).find((task) => task.executor === "browser");
    if (!inspection.ok) {
      if (browserTask) this.#task(project.id, browserTask.id, { status: "failed", attempt: true, evidence: { kind: "inspection", findings: inspection.findings.slice(0, 20) } });
      return this.#toRepair(project, { stage: "reviewing", check: "browser", findings: inspection.findings.slice(0, 20) });
    }
    if (browserTask) this.#task(project.id, browserTask.id, { status: "passed", attempt: true, evidence: { kind: "inspection", limited: Boolean(inspection.limited), ...inspection.evidence } });
    const polish = this.#tasks(project.id).find((task) => task.kind === "polish" && task.status === "pending");
    if (polish) {
      if (await this.#coderReady()) {
        this.#move(project.id, "repairing", "Everything works; one polish pass on the interface.", { kind: "polish", task: { id: polish.id, objective: polish.objective }, findings: inspection.findings });
        return true;
      }
      this.#task(project.id, polish.id, { status: "skipped", evidence: { kind: "capability", missing: "model", note: "Polish needs a coding model; the app works without it." } });
    }
    const tasks = this.#tasks(project.id);
    const unfinished = tasks.filter((task) => !["passed", "skipped"].includes(task.status));
    if (unfinished.length) {
      this.#move(project.id, "failed", `Checks and inspection pass, but ${unfinished.map((t) => `"${t.title}"`).join(", ")} ${unfinished.length === 1 ? "is" : "are"} not done.`, { kind: "incomplete", tasks: unfinished.map((t) => ({ id: t.id, status: t.status })) });
      return false;
    }
    this.#move(project.id, "ready", `Ready: ${project.spec.name} is running at ${project.preview?.url}.`, { kind: "ready", summary: readySummary(project, tasks, inspection) });
    return false;
  }
}

async function countTestsAt(folder, commit) {
  const result = await git(folder, ["grep", "-c", "-E", "^[[:space:]]*(test|it)(\\.(only|skip|todo))?\\(", commit, "--", "tests"], { okCodes: [0, 1] });
  return result.stdout.split("\n").filter(Boolean).reduce((sum, line) => sum + Number(line.split(":").at(-1) || 0), 0);
}

/** What the owner is told when the project is ready. */
export function readySummary(project, tasks, inspection) {
  const checks = tasks.find((task) => task.executor === "checks")?.evidence?.findLast?.((e) => e.kind === "checks")?.results ?? [];
  const skipped = tasks.filter((task) => task.status === "skipped");
  return {
    preview: project.preview?.url ?? null,
    folder: project.workspace,
    template: project.plan.template,
    features: project.spec.workflows.map((flow) => flow.title),
    pages: (project.spec.pages ?? []).map((page) => page.title),
    verification: checks.map((result) => ({ step: result.name, ok: result.exitCode === 0, tests: result.summary ?? null })),
    inspection: { limited: Boolean(inspection.limited), checks: inspection.evidence?.checks ?? null },
    repairs: project.repairsUsed,
    limitations: [
      ...skipped.map((task) => `${task.title}: skipped (${task.evidence.at(-1)?.note ?? "not run"})`),
      ...project.spec.integrations.map((integration) => `${integration.label} is built switched off until you connect ${integration.needs}.`),
      ...(inspection.limited ? ["The interface was checked over HTTP only; no browser was available for a full visual check."] : []),
    ],
    next: ["Open the app", "Ask for a change", "Publish (asks first)"],
  };
}

