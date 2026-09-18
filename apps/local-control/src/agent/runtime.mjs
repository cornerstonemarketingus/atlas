import { randomUUID } from "node:crypto";

import { BudgetExceededError, BudgetLedger } from "./budget.mjs";
import { completionEvent, errorEvent, statusEvent } from "./events.mjs";
import { RunCancelledError, RunControl } from "./run-control.mjs";

const DEFAULT_LEASE_MS = 30_000;
const DEFAULT_HEARTBEAT_MS = 10_000;

/**
 * Statuses a session can be retried or resumed out of. `idle` and `queued`
 * are here because a process that dies between queuing a turn and starting it
 * leaves the session in one of them with work still pending; refusing to
 * resume those would strand the turn forever.
 */
const RESUMABLE = new Set(["idle", "queued", "interrupted", "failed", "cancelled", "paused", "awaiting_approval"]);

export class AgentRuntimeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "AgentRuntimeError";
    this.code = code;
  }
}

/**
 * The long-running owner of agent execution.
 *
 * Atlas used to dispatch a GitHub Actions workflow and read the result back
 * out of a log. The runtime replaces that: it holds sessions open across
 * restarts, streams normalized events to whoever is attached, and treats a
 * remote executor as one adapter among several. GitHub is now a place Atlas
 * can *publish* to, not the thing that runs it.
 */
export class AgentRuntime {
  #sessions;
  #executors;
  #audit;
  #instanceId;
  #leaseMs;
  #heartbeatMs;
  #runs = new Map();
  #listeners = new Map();
  #stopped = false;

  constructor({
    sessions,
    executors,
    audit = () => {},
    instanceId = randomUUID(),
    leaseMs = DEFAULT_LEASE_MS,
    heartbeatMs = DEFAULT_HEARTBEAT_MS,
  }) {
    if (!sessions) throw new Error("An agent session store is required.");
    if (!executors || Object.keys(executors).length === 0) throw new Error("At least one executor is required.");
    this.#sessions = sessions;
    this.#executors = executors;
    this.#audit = audit;
    this.#instanceId = instanceId;
    this.#leaseMs = leaseMs;
    this.#heartbeatMs = heartbeatMs;
  }

  get instanceId() { return this.#instanceId; }
  executorIds() { return Object.keys(this.#executors); }
  listSessions(limit = 50) { return this.#sessions.sessions(limit); }
  getSession(sessionId) { return this.#sessions.session(sessionId); }
  getTurns(sessionId) { return this.#sessions.turns(sessionId); }
  getEvents(sessionId, afterSequence = 0) { return this.#sessions.events(sessionId, afterSequence); }

  /**
   * Boot-time recovery. A session whose lease has lapsed was being run by a
   * process that is gone; its in-flight turn goes back on the queue and the
   * session is marked interrupted rather than silently left "running" for a
   * runtime that will never report back.
   */
  recover() {
    const recovered = [];
    for (const sessionId of this.#sessions.staleRunningSessions(new Date().toISOString())) {
      for (const turn of this.#sessions.turns(sessionId)) {
        if (turn.state === "running") this.#sessions.requeueTurn(turn.id);
      }
      this.#sessions.clearLease(sessionId);
      this.#sessions.setStatus(sessionId, "interrupted", "Atlas restarted while this session was running.");
      this.#emit(sessionId, statusEvent("Atlas restarted; this session was interrupted and can be resumed.", { recoverable: true }));
      recovered.push(sessionId);
    }
    return recovered;
  }

  createSession({ title, repository = null, model, executor = "local", budget = {} }) {
    if (!this.#executors[executor]) throw new AgentRuntimeError("UNKNOWN_EXECUTOR", `No executor named '${executor}' is registered.`);
    const session = this.#sessions.createSession({ title, repository, model, executor, budget });
    this.#emit(session.id, statusEvent(`Session created for ${executor} execution.`, { executor }));
    return this.#sessions.session(session.id);
  }

  /**
   * Adds a user turn and starts the run when nothing is already running.
   * Turns submitted mid-run queue behind the current one, which is what makes
   * "talk to Atlas while it works" a queue rather than a race.
   */
  submitTurn(sessionId, { text, attachments = [] }) {
    const session = this.#requireSession(sessionId);
    if (session.status === "cancelled" || session.status === "completed" || session.status === "failed") {
      this.#sessions.setStatus(sessionId, "idle");
    }
    const turn = this.#sessions.addTurn({ sessionId, role: "user", text, attachments });
    // Marked queued *before* the run starts, so a crash in the gap leaves a
    // status that boot-time recovery looks at rather than a silent `idle`.
    if (!this.#runs.has(sessionId)) this.#sessions.setStatus(sessionId, "queued");
    this.#emit(sessionId, statusEvent("Turn queued.", { turnId: turn.id }));
    this.#start(sessionId);
    return { session: this.#sessions.session(sessionId), turn };
  }

  /**
   * Replays everything after `afterSequence`, then streams live events.
   *
   * The listener is registered *before* the replay read and live events are
   * buffered until the replay drains, so a client that reconnects mid-run
   * cannot fall into the gap between "what was stored" and "what happens
   * next". Duplicate sequences are dropped rather than delivered twice.
   */
  subscribe(sessionId, afterSequence, listener) {
    this.#requireSession(sessionId);
    const buffered = [];
    let draining = true;
    const buffer = (event) => { if (draining) buffered.push(event); else listener(event); };
    const listeners = this.#listeners.get(sessionId) ?? new Set();
    listeners.add(buffer);
    this.#listeners.set(sessionId, listeners);

    const unsubscribe = () => {
      const current = this.#listeners.get(sessionId);
      if (!current) return;
      current.delete(buffer);
      if (current.size === 0) this.#listeners.delete(sessionId);
    };

    try {
      let delivered = afterSequence;
      for (const event of this.#sessions.events(sessionId, afterSequence, 5_000)) {
        listener(event);
        delivered = event.sequence;
      }
      draining = false;
      for (const event of buffered) if (event.sequence > delivered) listener(event);
    } catch (error) {
      unsubscribe();
      throw error;
    }

    return unsubscribe;
  }

  pause(sessionId) {
    const run = this.#runs.get(sessionId);
    if (!run) throw new AgentRuntimeError("NOT_RUNNING", "Only a running session can be paused.");
    run.control.pause();
    this.#emit(sessionId, statusEvent("Pause requested; the run stops at its next checkpoint."));
    return this.#sessions.session(sessionId);
  }

  resume(sessionId) {
    const session = this.#requireSession(sessionId);
    const run = this.#runs.get(sessionId);
    if (run) {
      run.control.resume();
      this.#sessions.setStatus(sessionId, "running");
      this.#emit(sessionId, statusEvent("Resumed."));
      return this.#sessions.session(sessionId);
    }
    if (!RESUMABLE.has(session.status)) {
      throw new AgentRuntimeError("NOT_RESUMABLE", `A ${session.status} session cannot be resumed.`);
    }
    for (const turn of this.#sessions.turns(sessionId)) {
      if (turn.state === "awaiting_approval") this.#sessions.requeueTurn(turn.id);
    }
    this.#emit(sessionId, statusEvent(session.status === "awaiting_approval" ? "Approved; continuing." : "Resuming after interruption."));
    this.#start(sessionId);
    return this.#sessions.session(sessionId);
  }

  cancel(sessionId) {
    const session = this.#requireSession(sessionId);
    const run = this.#runs.get(sessionId);
    if (run) {
      run.control.cancel("cancelled");
      return this.#sessions.session(sessionId);
    }
    for (const turn of this.#sessions.turns(sessionId)) {
      if (turn.state === "pending" || turn.state === "running") this.#sessions.setTurnState(turn.id, "cancelled");
    }
    this.#sessions.setStatus(sessionId, "cancelled", "Cancelled before the run started.");
    this.#emit(sessionId, completionEvent({ status: "cancelled", summary: "Cancelled before the run started." }));
    return this.#sessions.session(session.id);
  }

  /**
   * Records that the operator refused. The session stops rather than looping:
   * an agent that re-proposes a refused action until it is approved is an
   * agent working around its operator.
   */
  denyApproval(sessionId, summary = "The operator denied this action.") {
    const session = this.#requireSession(sessionId);
    if (session.status !== "awaiting_approval") return session;
    for (const turn of this.#sessions.turns(sessionId)) {
      if (turn.state === "awaiting_approval") this.#sessions.setTurnState(turn.id, "denied");
    }
    this.#sessions.setStatus(sessionId, "cancelled", `Denied: ${summary}`);
    this.#emit(sessionId, completionEvent({ status: "denied", summary: `The operator denied this action: ${summary}` }));
    return this.#sessions.session(sessionId);
  }

  /** Puts the last unfinished turn back on the queue and runs it again. */
  retry(sessionId) {
    const session = this.#requireSession(sessionId);
    if (this.#runs.has(sessionId)) throw new AgentRuntimeError("ALREADY_RUNNING", "This session is already running.");
    if (!RESUMABLE.has(session.status)) {
      throw new AgentRuntimeError("NOT_RETRYABLE", `A ${session.status} session cannot be retried.`);
    }
    const turns = this.#sessions.turns(sessionId).filter((turn) => turn.role === "user");
    const last = [...turns].reverse().find((turn) => turn.state !== "completed");
    if (!last) throw new AgentRuntimeError("NOTHING_TO_RETRY", "No unfinished turn to retry.");
    this.#sessions.requeueTurn(last.id);
    this.#emit(sessionId, statusEvent("Retrying the last unfinished turn.", { turnId: last.id }));
    this.#start(sessionId);
    return this.#sessions.session(sessionId);
  }

  /**
   * Answers the last user turn again, discarding the answer it already gave.
   * The turn is not duplicated: regenerating is a second attempt at the same
   * question, and a transcript that showed it twice would be a lie.
   */
  regenerate(sessionId) {
    const session = this.#requireSession(sessionId);
    if (this.#runs.has(sessionId)) throw new AgentRuntimeError("ALREADY_RUNNING", "Stop the current run before regenerating.");
    const last = [...this.#sessions.turns(sessionId)].reverse().find((turn) => turn.role === "user");
    if (!last) throw new AgentRuntimeError("NOTHING_TO_REGENERATE", "This session has no turn to regenerate.");
    this.#sessions.requeueTurn(last.id);
    this.#sessions.setStatus(sessionId, "queued");
    this.#emit(sessionId, statusEvent("Regenerating the last answer.", { turnId: last.id }));
    this.#start(sessionId);
    return this.#sessions.session(session.id);
  }

  /**
   * Rewrites a turn and answers it again. Everything after it is removed,
   * because those answers replied to a question that no longer exists.
   */
  editAndResend(sessionId, turnId, { text, attachments = null }) {
    this.#requireSession(sessionId);
    if (this.#runs.has(sessionId)) throw new AgentRuntimeError("ALREADY_RUNNING", "Stop the current run before editing a turn.");
    const turn = this.#sessions.turn(turnId);
    if (!turn || turn.sessionId !== sessionId) throw new AgentRuntimeError("UNKNOWN_TURN", "That turn is not part of this session.");
    if (turn.role !== "user") throw new AgentRuntimeError("UNKNOWN_TURN", "Only a turn you sent can be edited.");
    const removed = this.#sessions.deleteTurnsAfter(sessionId, turnId);
    this.#sessions.updateTurnText(turnId, text, attachments);
    this.#sessions.requeueTurn(turnId);
    this.#sessions.setStatus(sessionId, "queued");
    this.#emit(sessionId, statusEvent(`Edited a message and resent it; ${removed} later message(s) were removed.`, { turnId }));
    this.#start(sessionId);
    return this.#sessions.session(sessionId);
  }

  /** Resolves once every in-flight run in this process has settled. */
  async drain() {
    while (this.#runs.size > 0) await Promise.allSettled([...this.#runs.values()].map((run) => run.finished));
  }

  async stop() {
    this.#stopped = true;
    for (const run of this.#runs.values()) run.control.cancel("shutdown");
    await this.drain();
  }

  #requireSession(sessionId) {
    const session = this.#sessions.session(sessionId);
    if (!session) throw new AgentRuntimeError("UNKNOWN_SESSION", "Session not found.");
    return session;
  }

  #start(sessionId) {
    if (this.#stopped || this.#runs.has(sessionId)) return;
    if (!this.#sessions.nextPendingTurn(sessionId)) return;
    const control = new RunControl({
      onPauseReached: () => {
        this.#sessions.setStatus(sessionId, "paused");
        this.#emit(sessionId, statusEvent("Paused."));
      },
    });
    const run = { control, finished: null };
    run.finished = this.#run(sessionId, control)
      // #run guards its executor call, but a store or lease failure outside
      // that guard would otherwise surface as an unhandled rejection and take
      // the whole daemon with it.
      .catch((error) => this.#fail(sessionId, "RUNTIME_FAILED", error instanceof Error ? error.message : "The runtime failed to start this run."))
      .finally(() => this.#runs.delete(sessionId));
    this.#runs.set(sessionId, run);
  }

  async #run(sessionId, control) {
    const session = this.#sessions.session(sessionId);
    const expiresAt = new Date(Date.now() + this.#leaseMs).toISOString();
    if (!this.#sessions.acquireLease(sessionId, this.#instanceId, expiresAt)) {
      this.#emit(sessionId, statusEvent("Another Atlas runtime holds this session's lease."));
      return;
    }

    const executor = this.#executors[session.executor];
    if (!executor) {
      this.#fail(sessionId, "UNKNOWN_EXECUTOR", `No executor named '${session.executor}' is registered.`);
      this.#sessions.releaseLease(sessionId, this.#instanceId);
      return;
    }

    const budget = new BudgetLedger({
      limits: session.budget,
      used: session.usage,
      onChange: (snapshot) => this.#sessions.recordUsage(sessionId, snapshot.used),
    });
    const startedAtMs = Date.now();
    let charged = false;
    const chargeElapsed = () => {
      if (charged) return;
      charged = true;
      // Capped at what is left, so the closing charge can never be the thing
      // that throws a budget error out of a cleanup path.
      budget.record({ elapsedMs: Math.min(Date.now() - startedAtMs, budget.remaining().elapsedMs) });
    };
    const remainingMs = Math.max(0, budget.remaining().elapsedMs);
    const deadline = setTimeout(() => control.cancel("time-budget"), remainingMs);
    const heartbeat = setInterval(() => {
      const renewed = this.#sessions.renewLease(sessionId, this.#instanceId, new Date(Date.now() + this.#leaseMs).toISOString());
      if (!renewed) control.cancel("lease-lost");
    }, this.#heartbeatMs);

    this.#sessions.setStatus(sessionId, "running");
    this.#emit(sessionId, statusEvent("Run started.", { executor: session.executor }));

    try {
      let turn = this.#sessions.nextPendingTurn(sessionId);
      while (turn) {
        await control.checkpoint();
        this.#sessions.setTurnState(turn.id, "running");
        const result = await executor.run({
          session: this.#sessions.session(sessionId),
          turn,
          history: this.#sessions.turns(sessionId),
          emit: (event) => this.#emit(sessionId, event),
          budget,
          signal: control.signal,
          checkpoint: () => control.checkpoint(),
        });
        // A cancel is authoritative. An executor that swallowed its abort
        // signal and returned "completed" anyway must not be able to report
        // success for work the operator stopped — Atlas does not claim a
        // completion it cannot evidence.
        await control.checkpoint();
        // A turn is only "completed" when it was actually answered. Leaving a
        // failed or blocked turn short of completed is what makes retry and
        // resume able to find it again.
        if (result?.status === "awaiting_approval") {
          this.#sessions.setTurnState(turn.id, "awaiting_approval");
          this.#sessions.setStatus(sessionId, "awaiting_approval", result.summary ?? "Waiting for approval.");
          this.#emit(sessionId, completionEvent({ status: "awaiting_approval", summary: result.summary ?? "Waiting for approval." }));
          return;
        }
        if (result?.status === "failed") {
          this.#sessions.setTurnState(turn.id, "failed");
          this.#finish(sessionId, "failed", result.summary ?? "The executor reported a failure.", budget);
          return;
        }
        this.#sessions.setTurnState(turn.id, "completed");
        turn = this.#sessions.nextPendingTurn(sessionId);
      }
      chargeElapsed();
      this.#finish(sessionId, "completed", "All queued turns are answered.", budget);
    } catch (error) {
      chargeElapsed();
      this.#handleRunError(sessionId, error, budget);
    } finally {
      clearTimeout(deadline);
      clearInterval(heartbeat);
      chargeElapsed();
      this.#sessions.releaseLease(sessionId, this.#instanceId);
    }
  }

  #handleRunError(sessionId, error, budget) {
    for (const turn of this.#sessions.turns(sessionId)) {
      if (turn.state === "running") this.#sessions.requeueTurn(turn.id);
    }
    if (error instanceof RunCancelledError) {
      const summary = {
        cancelled: "Cancelled by the operator.",
        "time-budget": "Stopped: the session's time budget is spent.",
        "lease-lost": "Stopped: another Atlas runtime took over this session.",
        shutdown: "Stopped: Atlas is shutting down.",
      }[error.reason] ?? "Cancelled.";
      const status = error.reason === "shutdown" ? "interrupted" : error.reason === "time-budget" ? "failed" : "cancelled";
      this.#finish(sessionId, status, summary, budget);
      return;
    }
    if (error instanceof BudgetExceededError) {
      this.#emit(sessionId, errorEvent({ code: error.code, summary: error.message, recoverable: false }));
      this.#finish(sessionId, "failed", error.message, budget);
      return;
    }
    const summary = error instanceof Error ? error.message : "Unknown executor failure.";
    this.#emit(sessionId, errorEvent({ code: "EXECUTOR_FAILED", summary, recoverable: true }));
    this.#finish(sessionId, "failed", summary, budget);
  }

  #finish(sessionId, status, summary, budget) {
    this.#sessions.setStatus(sessionId, status, summary);
    this.#emit(sessionId, completionEvent({ status, summary, usage: budget?.snapshot().used ?? null }));
  }

  #fail(sessionId, code, summary) {
    this.#emit(sessionId, errorEvent({ code, summary, recoverable: false }));
    this.#sessions.setStatus(sessionId, "failed", summary);
  }

  /**
   * Persist, audit, then fan out — in that order. An event that cannot be
   * written or audited must not reach a client, because a client that saw it
   * would believe an action is on the record when it is not.
   */
  #emit(sessionId, event) {
    const stored = this.#sessions.appendEvent(sessionId, event);
    this.#audit(`agent.${stored.kind}`, auditSummary(stored));
    for (const listener of this.#listeners.get(sessionId) ?? []) {
      try {
        listener(stored);
      } catch {
        // A broken subscriber must not take down the run that is feeding it.
      }
    }
    return stored;
  }
}

function auditSummary(event) {
  const data = event.data ?? {};
  const detail = data.summary ?? data.text ?? data.status ?? data.name ?? event.kind;
  return `${event.sessionId}#${event.sequence} ${event.kind}: ${String(detail).slice(0, 400)}`;
}
