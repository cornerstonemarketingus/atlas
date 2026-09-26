"use client";
import { useEffect, useRef, useState } from "react";
import { AtlasMark } from "../AtlasMark.js";
import { DiffLines } from "./MessageBody.js";
import type { LogLine, WorkItem } from "./Workspace.js";

type Task = { taskId: string; objective: string; mode: string; status?: string; run?: { id?: number; url: string | null } | null; pullRequest?: { url: string | null; number: number; merged: boolean } | null };
type Step = { label: string; state: "done" | "running" | "pending" | "failed"; startedAt: string | null; completedAt: string | null };
type Activity = { status: string | null; conclusion: string | null; url: string | null; steps: Step[] };
type ChangedFile = { path: string; previousPath: string | null; status: string; additions: number; deletions: number; patch: string | null; truncated: boolean };
type Changes = { pullRequest: { number: number; url: string | null; title: string } | null; files: ChangedFile[]; additions: number; deletions: number };

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
export function TaskActivity({ task, onLog, onChanges, onOpenFile }: {
  readonly task: Task;
  readonly onLog?: (line: Omit<LogLine, "id" | "at">) => void;
  readonly onChanges?: (items: WorkItem[]) => void;
  readonly onOpenFile?: (id: string) => void;
}) {
  const [activity, setActivity] = useState<Activity | null>(null);
  const [changes, setChanges] = useState<Changes | null>(null);
  const [openDiff, setOpenDiff] = useState<string | null>(null);
  const logged = useRef(new Map<string, string>());
  // The parent's callbacks change identity every render; effects read the latest through refs instead of re-running.
  const callbacks = useRef({ onLog, onChanges });
  useEffect(() => { callbacks.current = { onLog, onChanges }; });
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

  // Each step's state change goes to the terminal once.
  useEffect(() => {
    const onLog = callbacks.current.onLog;
    if (!onLog) return;
    for (const step of activity?.steps ?? []) {
      if (logged.current.get(step.label) === step.state) continue;
      logged.current.set(step.label, step.state);
      if (step.state === "pending") continue;
      onLog({ kind: "run", state: step.state, who: MODE_TITLE[task.mode] ?? "Run", text: `${step.state === "running" ? "▸" : step.state === "done" ? "✓" : "✕"} ${step.label}` });
    }
  }, [activity, task.mode]);

  // A coder run's edits, once it has a pull request: shown here as diffs and handed to the Files panel.
  const hasPullRequest = Boolean(task.pullRequest?.number);
  useEffect(() => {
    if (task.mode !== "coder" || (!hasPullRequest && live)) return;
    let active = true;
    void fetch(`/api/tasks/${encodeURIComponent(task.taskId)}/changes`, { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : null))
      .then((value: Changes | null) => {
        if (!active || !value || !value.files.length) return;
        setChanges(value);
        callbacks.current.onChanges?.(value.files.map((file) => ({ id: `diff:${task.taskId}:${file.path}`, kind: "diff", title: file.path, path: file.path, status: file.status, additions: file.additions, deletions: file.deletions, patch: file.patch, truncated: file.truncated, pullRequestUrl: value.pullRequest?.url ?? null })));
      })
      .catch(() => undefined);
    return () => { active = false; };
  }, [task.taskId, task.mode, hasPullRequest, live]);

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
      {changes && <div className="changed-files">
        <p className="changed-head">Edited {changes.files.length} file{changes.files.length === 1 ? "" : "s"} <b className="plus">+{changes.additions}</b> <b className="minus">−{changes.deletions}</b></p>
        <ul>{changes.files.map((file) => {
          const id = `diff:${task.taskId}:${file.path}`;
          return <li key={file.path}>
            <button type="button" className="changed-file" aria-expanded={openDiff === file.path} onClick={() => setOpenDiff((current) => current === file.path ? null : file.path)}>
              <span className={`file-kind kind-${file.status}`}>{file.status[0].toUpperCase()}</span>
              <span className="file-name">{file.path}</span>
              <small><b className="plus">+{file.additions}</b> <b className="minus">−{file.deletions}</b></small>
            </button>
            {onOpenFile && <button type="button" className="open-in-panel" onClick={() => onOpenFile(id)} title="Open in the Files panel">⤢</button>}
            {openDiff === file.path && (file.patch ? <pre className="md-code diff-view"><code><DiffLines patch={file.patch} /></code></pre> : <p className="activity-objective">No text diff (binary or too large).</p>)}
          </li>;
        })}</ul>
      </div>}
      <div className="result-links">
        {task.pullRequest?.url && <a className="result-link" href={task.pullRequest.url} target="_blank" rel="noreferrer">Review the pull request ↗</a>}
        {runUrl && <a className="result-link" href={runUrl} target="_blank" rel="noreferrer">Full log ↗</a>}
      </div>
    </div>
  </div>;
}
