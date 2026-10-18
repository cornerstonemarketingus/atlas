"use client";
import { useEffect, useState } from "react";
import { readTaskRequests, requestExplanation, reconcileTaskRequest, configureTaskObservation, observationHealthExplanation } from "./request-inspection-client.mjs";
import "./request-history.css";

type SavedRequest = {
  requestKey: string; createdAt: string; state: string; receiptState: string; outcomeStatus: number | null;
  task: null | { taskId: string; conversationId: string | null; repository: string; branch: string; objective: string; dispatchState: string; execution?: null | { runId: number; runAttempt: number; claimedAt: string; expiresAt: string; observation?: null | { enabled: boolean; expiresAt: string; attempts: number; limit: number; health?: null | { state: string; reason: string | null; lastCheckAt: string | null; lastStatus: string | null; eligibleAfter: string | null } }; outcome?: null | { jobId: number; conclusion: string; completedAt: string; verifiedAt: string } } };
};

/** Read-only investigation remains reachable without a composer draft or local retry cache. */
export function RequestHistory({ version = 0 }: { version?: number }) {
  const [open, setOpen] = useState(false);
  const [requests, setRequests] = useState<SavedRequest[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [previous, setPrevious] = useState<Array<string | null>>([]);
  const [notice, setNotice] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [checking, setChecking] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    let active = true;
    const load = async () => {
      setLoading(true);
      try {
        const body = await readTaskRequests({ cursor, signal: controller.signal });
        if (active) { setRequests(body.requests); setNextCursor(body.nextCursor); setNotice(""); }
      } catch {
        if (active) { setRequests([]); setNextCursor(null); setNotice("Saved requests are unavailable. Try again later."); }
      }
      finally { if (active) setLoading(false); }
    };
    void load();
    const timer = setInterval(() => { if (!document.hidden) void load(); }, 12000);
    return () => { active = false; controller.abort(); clearInterval(timer); };
  }, [open, cursor, refresh, version]);

  async function check(requestKey: string) {
    setChecking(requestKey);
    try {
      const body = await readTaskRequests({ requestKey });
      setRequests(items => items.map(item => item.requestKey === requestKey ? body.request : item));
      setNotice("");
    } catch {
      setRequests([]); setNextCursor(null);
      setNotice("This request is unavailable. Refresh its history to check access and status.");
    }
    finally { setChecking(null); }
  }

  async function reconcile(requestKey: string) {
    setChecking(requestKey);
    try {
      const body = await reconcileTaskRequest({ requestKey });
      setRequests(items => items.map(item => item.requestKey === requestKey ? body.request : item));
      setNotice("Execution evidence checked. No task was started or retried.");
    } catch {
      setRequests([]); setNextCursor(null);
      setNotice("Execution evidence is unavailable. Refresh saved requests before checking again. No task was started.");
    } finally { setChecking(null); }
  }

  async function observe(requestKey: string, enabled: boolean) {
    setChecking(requestKey);
    try {
      const body = await configureTaskObservation({ requestKey, enabled });
      setRequests(items => items.map(item => item.requestKey === requestKey ? body.request : item));
      setNotice(enabled ? "Automatic status checks enabled with fixed limits. Execution will not be retried." : "Future automatic checks stopped. An in-flight check may finish.");
    } catch { setRequests([]); setNextCursor(null); setNotice("Observation settings unavailable. Refresh saved requests before trying again."); }
    finally { setChecking(null); }
  }

  return <details className="request-history" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>Saved requests</summary>
    {open && <div className="request-history-body">
      <p>Check an earlier request after reconnecting. These checks do not start or bill another task.</p>
      <button type="button" disabled={loading} onClick={() => setRefresh(value => value + 1)}>Refresh requests</button>
      {notice && <p role="status">{notice}</p>}
      {!loading && !notice && requests.length === 0 && <p>No saved requests in this workspace.</p>}
      {requests.map(request => <article key={request.requestKey}>
        <h3>{request.task?.objective || `Request ${request.requestKey.slice(0, 8)}`}</h3>
        <p>{requestExplanation(request)}</p>
        {request.task?.execution && <p>Execution reserved for run {request.task.execution.runId}, attempt {request.task.execution.runAttempt}. Lease ends {request.task.execution.expiresAt}. Expiry requires investigation; it does not authorize a retry.</p>}
        {request.task?.execution?.outcome && <p>GitHub execution job {request.task.execution.outcome.jobId}: {request.task.execution.outcome.conclusion}, completed {request.task.execution.outcome.completedAt}. Verified by Atlas at {request.task.execution.outcome.verifiedAt}. This job result does not prove code validation or authorize a retry.</p>}
        {request.task?.execution?.observation && <p>Automatic checks {request.task.execution.observation.enabled ? "enabled" : "stopped"}: {request.task.execution.observation.attempts}/{request.task.execution.observation.limit}, until {request.task.execution.observation.expiresAt}. Daily budgets may delay checks; execution is never retried.</p>}
        {request.task?.execution && !request.task.execution.outcome && !request.task.execution.observation && <p>Optional automatic checks run for up to 24 hours and stop after eight checks. They never retry execution.</p>}
        {request.task?.execution?.observation?.health && <p>{observationHealthExplanation(request.task.execution.observation.health)}{request.task.execution.observation.health.lastCheckAt ? ` Last check: ${request.task.execution.observation.health.lastCheckAt} (${request.task.execution.observation.health.lastStatus}).` : ""}{request.task.execution.observation.health.eligibleAfter ? ` Eligible after ${request.task.execution.observation.health.eligibleAfter}; scheduled capacity may delay it.` : ""}</p>}
        <small>{request.createdAt} UTC{request.task ? ` · ${request.task.repository} · ${request.task.branch}` : ""}</small>
        <div className="request-history-actions">
          <button type="button" disabled={checking !== null} onClick={() => void check(request.requestKey)}>{checking === request.requestKey ? "Checking…" : "Check request"}</button>
          {request.task?.execution && !request.task.execution.outcome && <button type="button" disabled={checking !== null} onClick={() => void reconcile(request.requestKey)}>Reconcile execution</button>}
          {request.task?.execution && !request.task.execution.outcome && <button type="button" disabled={checking !== null} onClick={() => void observe(request.requestKey, !request.task?.execution?.observation?.enabled)}>{request.task.execution.observation?.enabled ? "Stop automatic checks" : "Enable automatic checks"}</button>}
          {request.task?.conversationId && <a href={`/?conversation=${encodeURIComponent(request.task.conversationId)}`}>Open task activity</a>}
        </div>
      </article>)}
      <nav aria-label="Request history pages">
        <button type="button" disabled={loading || previous.length === 0} onClick={() => { setCursor(previous.at(-1) ?? null); setPrevious(items => items.slice(0, -1)); }}>Newer</button>
        <button type="button" disabled={loading || !nextCursor} onClick={() => { setPrevious(items => [...items, cursor]); setCursor(nextCursor); }}>Older</button>
      </nav>
    </div>}
  </details>;
}
