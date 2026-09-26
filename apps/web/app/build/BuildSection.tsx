"use client";
import Link from "next/link";
import { statusLine } from "./task-presentation.mjs";
import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { AtlasMark } from "../AtlasMark.js";
import { AtlasShell } from "../AtlasShell.js";
import { ThreadRail, useThreads } from "../ThreadRail.js";
import { PROJECT_CHANGE_EVENT, PROJECT_STORAGE_KEY } from "../ProjectSwitcher.js";

type Task = {
  taskId: string; conversationId?: string | null; objective: string; repository: string; branch: string;
  mode: string; status: string; createdAt: string;
  run?: { id: number; url: string | null } | null;
  pullRequest?: { url: string | null; number: number; merged: boolean } | null;
};
type Message = { id: string; role: string; content: string; createdAt: string };
type RunEvent = { id: string; taskId: string | null; kind: string; label: string; detail: string | null; createdAt: string };
type Detail = { messages?: Message[]; events?: RunEvent[]; tasks?: Task[] };
type GitHubOptions = { repositories: string[]; branches: string[]; defaultBranch: string };

const TASK_POLL_MS = 12_000;

/** Statuses after which nothing more will change, so the last trace step reads as done rather than in flight. */
const TERMINAL = new Set(["succeeded", "failed", "cancelled", "timed_out", "skipped"]);

/**
 * Only what Atlas actually observes about a run: that the dispatch was
 * accepted, which Actions run it belongs to, and that run's state. Nothing
 * here describes what happened *inside* the run, because nothing reports
 * that back yet.
 */
const PROGRESS: Record<string, string[]> = {
  dispatched: ["Request sent", "Waiting for the run to appear"],
  queued: ["Request sent", "Run queued on GitHub Actions"],
  running: ["Request sent", "Run started", "Running now"],
  succeeded: ["Request sent", "Run started", "Run finished"],
  failed: ["Request sent", "Run started", "Run finished with a failure"],
  cancelled: ["Request sent", "Run started", "Run cancelled"],
  timed_out: ["Request sent", "Run started", "Run timed out"],
};

const MODES = [
  { id: "inspect", label: "Review", hint: "Read the project and report findings. Changes nothing." },
  { id: "debug", label: "Debug", hint: "Build and run the tests to find what is actually broken." },
  { id: "coder", label: "Make changes", hint: "Write the change, run the tests, and open a pull request." },
];

const STARTERS = [
  { title: "Build a landing page", detail: "Sites & front-end", prompt: "Add a marketing landing page with a hero, three feature sections, and a sign-up call to action." },
  { title: "Add a feature", detail: "Apps & product", prompt: "Add a feature to this project. Read the codebase first, propose the smallest version that works, then build it." },
  { title: "Fix what's broken", detail: "Debug & validate", prompt: "Diagnose the currently failing tests and fix the root cause, not the symptom." },
];

/** Code: the detailed view of a conversation's code work — the advanced workspace for review, debugging, and code changes. */
export function BuildSection() {
  const [repository, setRepository] = useState("cornerstonemarketingus/atlas");
  const [repositoryOptions, setRepositoryOptions] = useState(["cornerstonemarketingus/atlas"]);
  const [branch, setBranch] = useState("main");
  const [branchOptions, setBranchOptions] = useState(["main"]);
  const [defaultBranch, setDefaultBranch] = useState("main");
  const [mode, setMode] = useState("inspect");
  const [objective, setObjective] = useState("");
  const [notice, setNotice] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [listening, setListening] = useState(false);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [thread, setThread] = useState<Detail | null>(null);
  const [github, setGitHub] = useState<{ connected: boolean; method: string; installUrl: string | null } | null>(null);
  const [panelTab, setPanelTab] = useState<"activity" | "changes">("activity");
  const [panelOpen, setPanelOpen] = useState(true);
  const [version, setVersion] = useState(0);
  const { threads, close } = useThreads(version);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const stored = window.localStorage.getItem(PROJECT_STORAGE_KEY);
    const timer = stored ? window.setTimeout(() => setRepository(stored), 0) : null;
    const update = (event: Event) => setRepository((event as CustomEvent<string>).detail);
    window.addEventListener(PROJECT_CHANGE_EVENT, update);
    return () => { if (timer) window.clearTimeout(timer); window.removeEventListener(PROJECT_CHANGE_EVENT, update); };
  }, []);

  const refreshTasks = useCallback(() => fetch("/api/tasks", { cache: "no-store" })
    .then((response) => (response.status === 401 ? (window.location.href = "/", null) : response.ok ? response.json() : null))
    .then((value: { tasks?: Task[] } | null) => { if (value?.tasks) setTasks(value.tasks); })
    .catch(() => undefined), []);

  useEffect(() => { void refreshTasks(); const timer = setInterval(() => { void refreshTasks(); }, TASK_POLL_MS); return () => clearInterval(timer); }, [refreshTasks]);

  useEffect(() => {
    let active = true;
    void fetch("/api/github/status").then((response) => (response.ok ? response.json() : null))
      .then((value) => { if (active && value) setGitHub(value as { connected: boolean; method: string; installUrl: string | null }); })
      .catch(() => undefined);
    return () => { active = false; };
  }, []);

  useEffect(() => {
    let active = true;
    void fetch(`/api/github/options?repository=${encodeURIComponent(repository)}`)
      .then((response) => (response.ok ? response.json() : null))
      .then((value) => {
        if (!active || !value) return;
        const options = value as GitHubOptions;
        if (options.repositories.length) setRepositoryOptions(options.repositories);
        if (options.branches.length) setBranchOptions(options.branches);
        setDefaultBranch(options.defaultBranch);
        if (!options.branches.includes(branch)) setBranch(options.defaultBranch);
      })
      .catch(() => undefined);
    return () => { active = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repository]);

  useEffect(() => { endRef.current?.scrollIntoView({ block: "end" }); }, [thread, tasks.length]);

  // A conversation's Code view opens straight onto that conversation's work.
  useEffect(() => {
    const requested = new URLSearchParams(window.location.search).get("conversation");
    if (requested && /^[0-9a-f-]{36}$/u.test(requested)) void openThread(requested);
  }, []);

  async function openThread(id: string) {
    setConversationId(id);
    setNotice("");
    try {
      const response = await fetch(`/api/conversations/${encodeURIComponent(id)}`, { cache: "no-store" });
      if (!response.ok) { setThread({ tasks: [] }); return; }
      // Messages and events were previously fetched and discarded, which made
      // every re-opened thread look empty. They are the record of the work.
      setThread(await response.json() as Detail);
    } catch {
      setNotice("That thread's history could not be loaded.");
    }
  }

  useEffect(() => {
    if (!conversationId) return;
    let active = true;
    const refresh = async () => {
      try {
        const response = await fetch(`/api/conversations/${encodeURIComponent(conversationId)}`, { cache: "no-store" });
        if (response.ok && active) setThread(await response.json() as Detail);
      } catch { /* Keep the last received evidence while offline. */ }
    };
    void refresh();
    const timer = setInterval(() => { void refresh(); }, TASK_POLL_MS);
    return () => { active = false; clearInterval(timer); };
  }, [conversationId]);

  function startNew() { setConversationId(null); setThread(null); setObjective(""); setNotice(""); }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!objective.trim() || submitting) return;
    setSubmitting(true); setNotice("");
    try {
      const response = await fetch("/api/tasks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ repository, branch, mode, objective, conversationId }),
      });
      const result = await response.json() as { message?: string; taskId?: string; conversationId?: string };
      if (!response.ok) { setNotice(result.message ?? "Atlas could not start this build."); return; }
      setNotice(`Sent. Atlas is working on it${result.taskId ? ` · ${result.taskId.slice(0, 8)}` : ""}.`);
      setObjective("");
      if (result.conversationId) {
        window.location.href = `/?conversation=${encodeURIComponent(result.conversationId)}`;
        return;
      }
      setVersion((value) => value + 1);
      void refreshTasks();
    } catch {
      setNotice("The task dispatcher is temporarily unavailable.");
    } finally {
      setSubmitting(false);
    }
  }

  function dictate() {
    type Recognition = { lang: string; interimResults: boolean; start: () => void; onresult: (event: { results: ArrayLike<{ 0: { transcript: string } }> }) => void; onend: () => void; onerror: () => void };
    const speech = (window as unknown as { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition }).SpeechRecognition
      ?? (window as unknown as { webkitSpeechRecognition?: new () => Recognition }).webkitSpeechRecognition;
    if (!speech) { setNotice("Dictation is not available in this browser."); return; }
    const recognition = new speech();
    recognition.lang = "en-US";
    recognition.interimResults = false;
    recognition.onresult = (event) => setObjective(`${objective}${objective ? " " : ""}${event.results[0][0].transcript}`);
    recognition.onend = () => setListening(false);
    recognition.onerror = () => setListening(false);
    setListening(true);
    recognition.start();
  }

  const threadTasks = thread?.tasks?.length
    ? thread.tasks.map((task) => tasks.find((live) => live.taskId === task.taskId) ?? { ...task, status: "dispatched" })
    : tasks.filter((task) => task.conversationId && task.conversationId === conversationId);
  const current = threadTasks.at(-1);
  const steps = PROGRESS[current?.status ?? "dispatched"] ?? PROGRESS.dispatched;
  const activeMode = MODES.find((item) => item.id === mode) ?? MODES[0];
  const disconnected = github?.connected === false;

  return <AtlasShell
    section="build"
    wide={panelOpen}
    rail={<ThreadRail threads={threads} activeId={conversationId} newLabel="New project task" emptyLabel="No project tasks yet."
      onNew={startNew} onOpen={(id) => void openThread(id)} onClose={(id) => void close(id).then((done) => { if (done && id === conversationId) startNew(); })} />}
    headerContext={<>
      <span className="context-chip">{repository}</span>
      <span className="context-chip">{branch}</span>
      {!panelOpen && <button className="panel-reopen" onClick={() => setPanelOpen(true)}>View work</button>}
    </>}
  >
    <div className="build-body">
      <div className="section-scroll">
        {!current && !thread ? <div className="section-empty">
          <div className="empty-mark"><AtlasMark /></div>
          <p className="kicker">PROJECTS</p>
          <h1>What should Atlas work on?</h1>
          <p>Pick a project and say what you want. Atlas reads the code, makes the change or reports back, runs your tests, and opens a pull request when it changes something.</p>
          <div className="starter-grid">
            {STARTERS.map((item) => <button key={item.title} onClick={() => setObjective(item.prompt)}>
              {item.title}<span>{item.detail}</span>
            </button>)}
          </div>
        </div> : <div className="message-stream">
          {(thread?.messages ?? []).map((item) => item.role === "user"
            ? <div className="user-message" key={item.id}><p>{item.content}</p></div>
            : <div className="atlas-message" key={item.id}><div className="assistant-avatar"><AtlasMark /></div><div><b>Atlas</b><p style={{ whiteSpace: "pre-wrap" }}>{item.content}</p></div></div>)}
          {!thread?.messages?.length && current && <div className="user-message"><p>{current.objective}</p></div>}
          {current && <div className="atlas-message">
            <div className="assistant-avatar"><AtlasMark /></div>
            <div>
              <b>Atlas</b>
              <p>{statusLine(current)}</p>
              <div className="work-trace">
                {steps.map((item, index) => <div key={item} className={index === steps.length - 1 && !TERMINAL.has(current.status) ? "working" : "done"}><i />{item}</div>)}
              </div>
              <div className="result-links">
                {current.pullRequest?.url && <a className="result-link" href={current.pullRequest.url} target="_blank" rel="noreferrer">Review the pull request ↗</a>}
                {current.run?.url && <a className="result-link" href={current.run.url} target="_blank" rel="noreferrer">Open the run log ↗</a>}
              </div>
            </div>
          </div>}
        </div>}
        <div ref={endRef} />
      </div>
      <form className="chat-composer" onSubmit={submit}>
        {disconnected && <p className="composer-blocked">
          GitHub is not connected, so Atlas has nothing to build against. <Link href="/setup">Open Connections →</Link>
        </p>}
        <textarea aria-label="Describe the project task" value={objective} rows={3} onChange={(event) => setObjective(event.target.value)}
          placeholder="Describe what you want Atlas to review, fix, or change…" />
        <div className="composer-actions">
          <div>
            <button type="button" title="Dictate" aria-label="Dictate" className={listening ? "listening" : ""} onClick={dictate}>⌁</button>
            <select aria-label="Task type" value={mode} onChange={(event) => setMode(event.target.value)}>
              {MODES.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
            </select>
            <span className="composer-hint">{activeMode.hint}</span>
          </div>
          <button className="send" disabled={submitting || !objective.trim() || disconnected}>{submitting ? "Starting…" : "Start task"}</button>
        </div>
        <div className="composer-context">
          <label>Project<select aria-label="Project" value={repository} onChange={(event) => setRepository(event.target.value)}>{repositoryOptions.map((value) => <option key={value}>{value}</option>)}</select></label>
          <label>Branch<select aria-label="Branch" value={branch} onChange={(event) => setBranch(event.target.value)}>{branchOptions.map((value) => <option key={value}>{value}{value === defaultBranch ? " · default" : ""}</option>)}</select></label>
          <span>Atlas can make mistakes. Check important changes.</span>
        </div>
        {notice && <p className="composer-notice" role="status">{notice}</p>}
      </form>
    </div>
    {panelOpen && <aside className="work-panel">
      <div className="panel-tabs" role="tablist" aria-label="Work details">
        <button className={panelTab === "activity" ? "active" : ""} role="tab" aria-selected={panelTab === "activity"} onClick={() => setPanelTab("activity")}>Activity</button>
        <button className={panelTab === "changes" ? "active" : ""} role="tab" aria-selected={panelTab === "changes"} onClick={() => setPanelTab("changes")}>Changes</button>
        <button className="panel-close" aria-label="Close work panel" title="Close panel" onClick={() => setPanelOpen(false)}>×</button>
      </div>
      {panelTab === "activity" && <div className="panel-section" role="tabpanel">
        {current ? <>
          <div className="run-summary">
            <span className={`run-state ${current.status}`}>{current.status}</span>
            <h2>{current.objective}</h2>
            <p>{current.repository}<br />{current.branch}</p>
          </div>
          <small>LIVE WORK</small>
          {(thread?.events?.length ? thread.events.map((event) => event.label) : steps).map((item) => <div className="panel-event" key={item}><i />{item}</div>)}
          <p className="panel-note">Status comes from GitHub. Findings appear here when the run finishes. No findings does not mean the tests passed.</p>
          {current.run?.url && <a className="result-link" href={current.run.url} target="_blank" rel="noreferrer">Open the run log ↗</a>}
        </> : <div className="panel-empty">
          <span aria-hidden="true">◌</span>
          <h2>Your work will appear here</h2>
          <p>Progress, test results, and the pull request appear here.</p>
        </div>}
      </div>}
      {panelTab === "changes" && <div className="panel-section" role="tabpanel">
        <small>RECENT WORK</small>
        {tasks.length === 0 && <p className="panel-note">Nothing yet. Pull requests Atlas opens are listed here.</p>}
        {tasks.map((task) => <div className="panel-task" key={task.taskId}>
          <span className={`run-state ${task.status}`}>{task.status}</span>
          <p>{task.objective}</p>
          <div className="panel-task-links">
            {task.run?.url && <a href={task.run.url} target="_blank" rel="noreferrer">Run log ↗</a>}
            {task.pullRequest?.url && <a href={task.pullRequest.url} target="_blank" rel="noreferrer">{task.pullRequest.merged ? `PR #${task.pullRequest.number} · merged` : `PR #${task.pullRequest.number}`} ↗</a>}
            {!task.run?.url && !task.pullRequest?.url && <span>No reviewable link yet</span>}
          </div>
        </div>)}
      </div>}
    </aside>}
  </AtlasShell>;
}
