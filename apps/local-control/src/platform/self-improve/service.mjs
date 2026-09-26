import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { git } from "../engineering/git.mjs";
import { assertAgentBranch, isProtectedBranch } from "../engineering/worktrees.mjs";

/**
 * "Atlas, improve yourself" as a service of the local daemon, so it can be
 * started from the app or from chat instead of a terminal.
 *
 * - One run at a time. A run is a number of SelfImprovementLoop iterations
 *   in the background; progress (the loop's log and the coder's output) is
 *   kept in a bounded buffer the UI polls.
 * - Accepted changes wait for the owner. `approve` merges the change's branch
 *   into the operator's checkout with a merge commit, and only when that
 *   checkout is clean and on a normal branch; a conflict is aborted, never
 *   resolved by Atlas. `reject` deletes the branch. Either way the decision
 *   is appended to decisions.jsonl (kept apart from the loop's ledger so a
 *   person's decision never changes the loop's own streak arithmetic).
 * - The service never pushes and never touches a remote.
 */

const MAX_LOG_LINES = 600;

export class SelfImprovementError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "SelfImprovementError";
    this.code = code;
  }
}

export class SelfImprovementService {
  /**
   * @param {{
   *   repository: string,
   *   decisionsPath: string,
   *   createLoop: (hooks: { log: (line: string) => void, onOutput: (text: string) => void }) => { run: (options: { iterations: number }) => Promise<{ results: object[], streak: number }>, history: () => object[], streak: () => number },
   *   now?: () => Date,
   * }} options
   */
  constructor({ repository, decisionsPath, createLoop, now = () => new Date() }) {
    this.repository = repository;
    this.decisionsPath = decisionsPath;
    this.createLoop = createLoop;
    this.now = now;
    this.current = null;
    this.lines = [];
    this.loop = createLoop({ log: (line) => this.#log(line), onOutput: (text) => this.#output(text) });
  }

  #log(line) {
    this.lines.push(`${this.now().toISOString().slice(11, 19)} ${line}`);
    if (this.lines.length > MAX_LOG_LINES) this.lines.splice(0, this.lines.length - MAX_LOG_LINES);
  }

  #output(text) {
    for (const line of String(text).split(/\r?\n/u)) if (line.trim()) this.#log(`  │ ${line.slice(0, 400)}`);
  }

  decisions() {
    if (!existsSync(this.decisionsPath)) return [];
    return readFileSync(this.decisionsPath, "utf8").split("\n").filter(Boolean).map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
  }

  #decide(id, decision, extra = {}) {
    mkdirSync(dirname(this.decisionsPath), { recursive: true });
    const record = { id, decision, at: this.now().toISOString(), ...extra };
    appendFileSync(this.decisionsPath, `${JSON.stringify(record)}\n`);
    return record;
  }

  /** Accepted changes nobody has approved or rejected yet. */
  pending() {
    const decided = new Set(this.decisions().map((entry) => entry.id));
    return this.loop.history().filter((entry) => entry.outcome === "accepted" && entry.branch && !decided.has(entry.id));
  }

  status() {
    const history = this.loop.history();
    return {
      running: Boolean(this.current),
      run: this.current ? { startedAt: this.current.startedAt, iterations: this.current.iterations } : null,
      streak: this.loop.streak(history),
      log: this.lines.slice(-200),
      pending: this.pending(),
      recent: history.slice(-20).reverse(),
      decisions: this.decisions().slice(-20).reverse(),
    };
  }

  /** Starts a run in the background. */
  start({ iterations = 1 } = {}) {
    if (this.current) throw new SelfImprovementError("ALREADY_RUNNING", "A self-improvement run is already in progress.");
    const count = Math.max(1, Math.min(20, Number.parseInt(String(iterations), 10) || 1));
    this.lines = [];
    this.#log(`Starting ${count} self-improvement iteration(s).`);
    const run = { startedAt: this.now().toISOString(), iterations: count };
    this.current = run;
    run.promise = this.loop.run({ iterations: count })
      .then(({ results, streak }) => {
        this.#log(`Finished: ${results.map((result) => result.outcome).join(", ") || "nothing ran"}. Streak ${streak}.`);
        return results;
      })
      .catch((error) => { this.#log(`The run stopped: ${error instanceof Error ? error.message : "unknown error"}`); return []; })
      .finally(() => { if (this.current === run) this.current = null; });
    return { ...this.status(), promise: run.promise };
  }

  #find(id) {
    const entry = this.pending().find((candidate) => candidate.id === id);
    if (!entry) throw new SelfImprovementError("UNKNOWN_CHANGE", "No accepted change with that id is waiting for a decision.");
    assertAgentBranch(entry.branch);
    return entry;
  }

  /** Merges an accepted change into the operator's checkout (clean tree, normal branch, no conflicts). */
  async approve(id) {
    if (this.current) throw new SelfImprovementError("BUSY", "Wait for the running self-improvement to finish before merging.");
    const entry = this.#find(id);
    const status = await git(this.repository, ["status", "--porcelain"]);
    if (status.stdout.trim()) throw new SelfImprovementError("DIRTY_CHECKOUT", "Your checkout has uncommitted changes; commit or stash them first.");
    const current = (await git(this.repository, ["symbolic-ref", "--quiet", "--short", "HEAD"], { okCodes: [0, 1] })).stdout.trim();
    if (!current) throw new SelfImprovementError("DETACHED_HEAD", "Check out a branch before merging.");
    if (current.startsWith("atlas/")) throw new SelfImprovementError("AGENT_BRANCH", "Switch to your own branch before merging an Atlas change.");
    const merge = await git(this.repository, ["-c", "user.name=Atlas", "-c", "user.email=atlas@users.noreply.invalid", "merge", "--no-ff", "--no-edit", "-m", `Merge Atlas self-improvement ${entry.id}`, entry.branch], { okCodes: [0, 1] });
    if (merge.code !== 0) {
      await git(this.repository, ["merge", "--abort"], { okCodes: [0, 1, 128] });
      throw new SelfImprovementError("MERGE_CONFLICT", "The change no longer merges cleanly; nothing was changed. Reject it and let Atlas try again on the current code.");
    }
    const head = (await git(this.repository, ["rev-parse", "HEAD"])).stdout.trim();
    await git(this.repository, ["branch", "-D", entry.branch], { okCodes: [0, 1] });
    this.#log(`Merged ${entry.branch} into ${current}${isProtectedBranch(current) ? " (a protected branch, on the owner's approval)" : ""}.`);
    return this.#decide(id, "approved", { branch: entry.branch, into: current, commit: head });
  }

  async reject(id, reason = "") {
    const entry = this.#find(id);
    await git(this.repository, ["branch", "-D", entry.branch], { okCodes: [0, 1] });
    this.#log(`Rejected ${entry.id}; deleted ${entry.branch}.`);
    return this.#decide(id, "rejected", { branch: entry.branch, reason: String(reason).slice(0, 500) });
  }
}

/** HTTP routes under /v1/self-improve. Reading needs any authenticated caller; acting needs the owner. */
export function createSelfImproveRoutes({ service, parseBody, send }) {
  return async function handle(request, response, identity) {
    const url = new URL(request.url ?? "/", "http://local.atlas");
    if (!url.pathname.startsWith("/v1/self-improve")) return false;
    const fail = (error) => send(response, error instanceof SelfImprovementError
      ? ({ ALREADY_RUNNING: 409, BUSY: 409, UNKNOWN_CHANGE: 404, DIRTY_CHECKOUT: 409, DETACHED_HEAD: 409, AGENT_BRANCH: 409, MERGE_CONFLICT: 409 }[error.code] ?? 400)
      : 500, { code: error.code ?? "ERROR", message: error.message ?? "The request failed." });
    try {
      if (request.method === "GET" && url.pathname === "/v1/self-improve") return send(response, 200, service.status());
      if (request.method !== "POST") return send(response, 405, { message: "Method not allowed." });
      if (identity.role !== "admin") return send(response, 403, { message: "Owner access required.", unblock: "Use the local owner token." });
      const body = await parseBody(request, response); if (!body) return true;
      if (url.pathname === "/v1/self-improve/runs") {
        const { promise, ...status } = service.start({ iterations: body.iterations });
        promise.catch(() => {});
        return send(response, 202, status);
      }
      const action = /^\/v1\/self-improve\/changes\/([A-Za-z0-9._-]{1,80})\/(approve|reject)$/u.exec(url.pathname);
      if (action) {
        const decision = action[2] === "approve" ? await service.approve(action[1]) : await service.reject(action[1], body.reason);
        return send(response, 200, { decision, status: service.status() });
      }
      return send(response, 404, { message: "Route not found." });
    } catch (error) {
      return fail(error);
    }
  };
}
