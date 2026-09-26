"use client";
import { useEffect, useState } from "react";
import { AtlasMark } from "../AtlasMark.js";

type Task = { taskId: string; objective: string; mode: string; status?: string; run?: { id?: number; url: string | null } | null; pullRequest?: { url: string | null; number: number; merged: boolean } | null };
type Step = { label: string; state: "done" | "running" | "pending" | "failed"; startedAt: string | null; completedAt: string | null };
type Activity = { status: string | null; conclusion: string | null; url: string | null; steps: Step[] };

const TERMINAL = new Set(["succeeded", "completed", "failed", "timed_out", "cancelled", "skipped"]);
const MODE_TITLE: Record<string, string> = { coder: "Changing code", inspect: "Reviewing the code", debug: "Debugging" };
const MARK: Record<Step["state"], string> = { done: "✓", running: "●", pending: "○", failed: "✕" };

function seconds(step: Step) {
  if (!step.startedAt) return "";
  const end = step.completedAt ? Date.parse(step.completedAt) : Date.now();
  const total = Math.max(0, Math.round((end - Date.parse(step.startedAt)) / 1000));
  return total < 60 ? `${total}s` : `${Math.floor(total / 60)}m ${total % 60}s`;
}

function headline(task: Task) {
  const status = task.status ?? "dispatched";
  if (["succeeded", "completed"].includes(status)) return task.mode === "coder" ? "Done. The change is ready." : "Done.";
  if (["failed", "timed_out"].includes(status)) return "This run did not finish successfully.";
  if (status === "cancelled") return "Cancelled.";
  if (status === "running") return "Working…";
  return "Starting…";
}

/**
 * One run, shown the way a coding agent shows its work: what it is doing
 * now, the steps behind it, and the result when it lands. Polls while the
 * run is live and stops once it has finished.
 */
export function TaskActivity({ task }: { readonly task: Task }) {
  const [activity, setActivity] = useState<Activity | null>(null);
  const [open, setOpen] = useState(true);
  const live = !TERMINAL.has(task.status ?? "dispatched");
  const runId = task.run?.id;

  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const query = runId ? `?runId=${runId}` : "";
        const response = await fetch(`/api/tasks/${encodeURIComponent(task.taskId)}/activity${query}`, { cache: "no-store" });
        if (response.ok && active) setActivity(await response.json() as Activity);
      } catch { /* keep the last known steps */ }
    };
    void load();
    if (!live) return () => { active = false; };
    const timer = setInterval(() => { void load(); }, 4_000);
    return () => { active = false; clearInterval(timer); };
  }, [task.taskId, runId, live]);

  const steps = activity?.steps ?? [];
  const current = steps.find((step) => step.state === "running");
  const runUrl = activity?.url ?? task.run?.url ?? null;

  return <div className="atlas-message task-activity" aria-live="polite">
    <div className="assistant-avatar"><AtlasMark /></div>
    <div>
      <b>Atlas</b>
      <button type="button" className="activity-head" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <span className={live ? "activity-dot live" : "activity-dot"} aria-hidden="true" />
        <span><strong>{MODE_TITLE[task.mode] ?? "Working"}</strong> · {headline(task)}</span>
        <span className="activity-toggle" aria-hidden="true">{open ? "▾" : "▸"}</span>
      </button>
      <p className="activity-objective">{task.objective}</p>
      {open && <ol className="activity-steps">
        {steps.length === 0 && <li className="pending"><span aria-hidden="true">○</span>Waiting for GitHub to start the run…</li>}
        {steps.map((step, index) => <li key={`${step.label}-${index}`} className={step.state}>
          <span aria-hidden="true">{MARK[step.state]}</span>{step.label}<small>{seconds(step)}</small>
        </li>)}
      </ol>}
      {!open && current && <p className="activity-now">Now: {current.label}</p>}
      <div className="result-links">
        {task.pullRequest?.url && <a className="result-link" href={task.pullRequest.url} target="_blank" rel="noreferrer">Review the pull request ↗</a>}
        {runUrl && <a className="result-link" href={runUrl} target="_blank" rel="noreferrer">Full log ↗</a>}
      </div>
    </div>
  </div>;
}
