"use client";
import Link from "next/link";
import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { AtlasMark } from "../AtlasMark.js";
import { AtlasShell } from "../AtlasShell.js";
import { ThreadRail, useThreads } from "../ThreadRail.js";

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

const PROGRESS: Record<string, string[]> = {
  dispatched: ["Request received", "Preparing a private workspace"],
  queued: ["Request received", "Waiting for secure compute"],
  running: ["Understanding your project", "Working through the requested change", "Validation will run next"],
  succeeded: ["Project understood", "Change completed", "Validation passed"],
  failed: ["Project understood", "Work stopped during validation"],
};

const MODES = [
  { id: "inspect", label: "Plan", hint: "Read the project and report back. Changes nothing." },
  { id: "debug", label: "Debug", hint: "Build and run the tests to find what is actually broken." },
  { id: "coder", label: "Build", hint: "Write the change and open a pull request for review." },
];

const STARTERS = [
  { title: "Build a landing page", detail: "Sites & front-end", prompt: "Add a marketing landing page with a hero, three feature sections, and a sign-up call to action." },
  { title: "Add a feature", detail: "Apps & product", prompt: "Add a feature to this project. Read the codebase first, propose the smallest version that works, then build it." },
  { title: "Fix what's broken", detail: "Debug & validate", prompt: "Diagnose the currently failing tests and fix the root cause, not the symptom." },
];

function statusLine(status: string): string {
  if (status === "succeeded") return "The work is complete and the result passed validation.";
  if (status === "failed") return "I stopped because the result did not pass its safety or validation checks.";
  return "I'm working through this now. You can follow the meaningful steps as they happen.";
}

/** Build: the section where Atlas writes code, sites, and apps against a repository. */
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
      if (result.conversationId) { setConversationId(result.conversationId); void openThread(result.conversationId); }
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
  const current = threadTasks.at(-1) ?? (conversationId === null ? undefined : tasks[0]);
  const steps = PROGRESS[current?.status ?? "dispatched"] ?? PROGRESS.dispatched;
  const activeMode = MODES.find((item) => item.id === mode) ?? MODES[0];
  const disconnected = github?.connected === false;

  return <AtlasShell
    section="build"
    wide={panelOpen}
    rail={<ThreadRail threads={threads} activeId={conversationId} newLabel="New build" emptyLabel="No builds yet. Describe one below."
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
          <p className="kicker">BUILD</p>
          <h1>What should we build?</h1>
          <p>Describe an outcome for a site, an app, or a change to this codebase. Atlas reads the project, does the work, validates it, and opens a pull request you review.</p>
          <div className="starter-grid">
            {STARTERS.map((item) => <button key={item.title} onClick={() => setObjective(item.prompt)}>
              {item.title}<span>{item.detail}</span>
            </button>)}
          </div>
        </div> : <div className="message-stream">
          {(thread?.messages ?? []).map((item) => item.role === "user"
            ? <div className="user-message" key={item.id}><p>{item.content}</p></div>
            : <div className="atlas-message" key={item.id}><div className="assistant-avatar"><AtlasMark /></div><div><b>Atlas</b><p>{item.content}</p></div></div>)}
          {!thread?.messages?.length && current && <div className="user-message"><p>{current.objective}</p></div>}
          {current && <div className="atlas-message">
            <div className="assistant-avatar"><AtlasMark /></div>
            <div>
              <b>Atlas</b>
              <p>{statusLine(current.status)}</p>
              <div className="work-trace">
                {steps.map((item, index) => <div key={item} className={index === steps.length - 1 && !["succeeded", "failed"].includes(current.status) ? "working" : "done"}><i />{item}</div>)}
              </div>
              {current.pullRequest?.url && <a className="result-link" href={current.pullRequest.url} target="_blank" rel="noreferrer">Review the completed change ↗</a>}
            </div>
          </div>}
        </div>}
        <div ref={endRef} />
      </div>
      <form className="chat-composer" onSubmit={submit}>
        {disconnected && <p className="composer-blocked">
          GitHub is not connected, so Atlas has nothing to build against. <Link href="/setup">Open Connections →</Link>
        </p>}
        <textarea aria-label="Describe the build" value={objective} rows={3} onChange={(event) => setObjective(event.target.value)}
          placeholder="Describe the site, app, or change you want Atlas to build…" />
        <div className="composer-actions">
          <div>
            <button type="button" title="Dictate" aria-label="Dictate" className={listening ? "listening" : ""} onClick={dictate}>⌁</button>
            <select aria-label="Build mode" value={mode} onChange={(event) => setMode(event.target.value)}>
              {MODES.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
            </select>
            <span className="composer-hint">{activeMode.hint}</span>
          </div>
          <button className="send" disabled={submitting || !objective.trim() || disconnected}>{submitting ? "…" : "↑"}</button>
        </div>
        <div className="composer-context">
          <label>Project<select aria-label="Project" value={repository} onChange={(event) => setRepository(event.target.value)}>{repositoryOptions.map((value) => <option key={value}>{value}</option>)}</select></label>
          <label>Branch<select aria-label="Branch" value={branch} onChange={(event) => setBranch(event.target.value)}>{branchOptions.map((value) => <option key={value}>{value}{value === defaultBranch ? " · default" : ""}</option>)}</select></label>
          <span>Atlas can make mistakes. Review consequential actions.</span>
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
          {current.run?.url && <a className="result-link" href={current.run.url} target="_blank" rel="noreferrer">Open the run log ↗</a>}
        </> : <div className="panel-empty">
          <span aria-hidden="true">◌</span>
          <h2>Your work will appear here</h2>
          <p>Runs, validation, and the pull request stay beside the conversation.</p>
        </div>}
      </div>}
      {panelTab === "changes" && <div className="panel-section" role="tabpanel">
        <small>RECENT BUILDS</small>
        {tasks.length === 0 && <p className="panel-note">Nothing built yet. The pull request Atlas opens will be listed here.</p>}
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
