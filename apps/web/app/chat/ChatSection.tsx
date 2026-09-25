"use client";
import Link from "next/link";
import { FormEvent, useEffect, useRef, useState } from "react";
import { AtlasMark } from "../AtlasMark.js";
import { AtlasShell } from "../AtlasShell.js";
import { PROJECT_CHANGE_EVENT, PROJECT_STORAGE_KEY } from "../ProjectSwitcher.js";
import { ThreadRail, useThreads } from "../ThreadRail.js";

type Message = { id: string; role: string; content: string; createdAt: string };
type Task = { taskId: string; objective: string; mode: string; status?: string; repository?: string; branch?: string; run?: { url: string | null } | null; pullRequest?: { url: string | null; number: number; merged: boolean } | null };
type Detail = { messages?: Message[]; tasks?: Task[] };

const STARTERS = [
  { title: "Review my project", prompt: "Review my project and tell me what I should improve first." },
  { title: "Fix a problem", prompt: "Fix the login bug in my project. Read the code first, run the tests, and open a pull request." },
  { title: "Plan my next step", prompt: "Help me decide what to build next and explain the simplest useful version." },
];

const TASK_WORDS = /\b(build|fix|implement|add|change|update|review|inspect|debug|test|refactor|create|write)\b/iu;
const READ_ONLY_WORDS = /\b(review|inspect|analy[sz]e|understand|explain|map)\b/iu;
const DEBUG_WORDS = /\b(debug|test|failing|broken|error|regression)\b/iu;

function taskMode(message: string) {
  if (!TASK_WORDS.test(message)) return null;
  if (DEBUG_WORDS.test(message)) return "debug";
  if (READ_ONLY_WORDS.test(message) && !/\b(fix|change|implement|add|write|create)\b/iu.test(message)) return "inspect";
  return "coder";
}

function taskStatusLabel(task: Task) {
  const status = task.status ?? "dispatched";
  if (["succeeded", "completed"].includes(status)) return "Task completed.";
  if (["failed", "timed_out", "cancelled"].includes(status)) return `Task ${status.replaceAll("_", " ")}.`;
  if (["running", "queued", "dispatched"].includes(status)) return "Atlas is working on this task.";
  return "Task received.";
}

/**
 * Chat is the main Atlas workspace. Questions stay in the conversation;
 * clear project requests use the existing approved task dispatcher.
 */
export function ChatSection() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState("");
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [repository, setRepository] = useState(() => typeof window === "undefined" ? "" : window.localStorage.getItem(PROJECT_STORAGE_KEY) ?? "");
  const [branch, setBranch] = useState("main");
  const [tasks, setTasks] = useState<Task[]>([]);
  const [ready, setReady] = useState<{ configured: boolean; reason: string | null } | null>(null);
  const [version, setVersion] = useState(0);
  const { threads, close } = useThreads(version);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let active = true;
    void fetch("/api/chat", { cache: "no-store" })
      .then((response) => (response.status === 401 ? (window.location.href = "/", null) : response.ok ? response.json() : null))
      .then((value) => { if (active && value) setReady(value as { configured: boolean; reason: string | null }); })
      .catch(() => undefined);
    return () => { active = false; };
  }, []);

  useEffect(() => {
    const update = (event: Event) => setRepository((event as CustomEvent<string>).detail);
    window.addEventListener(PROJECT_CHANGE_EVENT, update);
    void fetch("/api/github/options", { cache: "no-store" }).then((response) => response.ok ? response.json() : null)
      .then((value: { repositories?: string[]; defaultBranch?: string } | null) => {
        if (!value) return;
        const selected = window.localStorage.getItem(PROJECT_STORAGE_KEY) || value.repositories?.[0] || "";
        if (selected) { setRepository(selected); window.localStorage.setItem(PROJECT_STORAGE_KEY, selected); }
        if (value.defaultBranch) setBranch(value.defaultBranch);
      }).catch(() => undefined);
    return () => window.removeEventListener(PROJECT_CHANGE_EVENT, update);
  }, []);

  useEffect(() => { endRef.current?.scrollIntoView({ block: "end" }); }, [messages, sending]);

  useEffect(() => {
    const requested = new URLSearchParams(window.location.search).get("conversation");
    if (!requested || !/^[0-9a-f-]{36}$/u.test(requested)) return;
    void fetch(`/api/conversations/${encodeURIComponent(requested)}`, { cache: "no-store" })
      .then((response) => response.ok ? response.json() : null)
      .then(async (detail: Detail | null) => {
        if (!detail) return;
        setConversationId(requested);
        setMessages(detail.messages ?? []);
        setTasks(await withLiveTaskStatus(detail.tasks ?? []));
      })
      .catch(() => setNotice("That conversation could not be loaded."));
  }, []);

  async function openThread(id: string) {
    setConversationId(id);
    setNotice("");
    try {
      const response = await fetch(`/api/conversations/${encodeURIComponent(id)}`, { cache: "no-store" });
      if (!response.ok) { setMessages([]); return; }
      const detail = await response.json() as Detail;
      // The previous workspace fetched this and then threw the messages away,
      // so re-opening a thread showed an empty room. They are the thread.
      setMessages(detail.messages ?? []);
      setTasks(await withLiveTaskStatus(detail.tasks ?? []));
    } catch {
      setNotice("That thread's history could not be loaded.");
    }
  }

  async function withLiveTaskStatus(items: Task[]) {
    if (!items.length) return items;
    try {
      const response = await fetch("/api/tasks", { cache: "no-store" });
      if (!response.ok) return items;
      const value = await response.json() as { tasks?: Task[] };
      const live = new Map((value.tasks ?? []).map((task) => [task.taskId, task]));
      return items.map((task) => ({ ...task, ...live.get(task.taskId) }));
    } catch {
      return items;
    }
  }

  function startNew() { setConversationId(null); setMessages([]); setTasks([]); setDraft(""); setNotice(""); }

  useEffect(() => {
    if (!conversationId) return;
    let active = true;
    const refresh = async () => {
      try {
        const response = await fetch(`/api/conversations/${encodeURIComponent(conversationId)}`, { cache: "no-store" });
        if (response.ok && active) {
          const detail = await response.json() as Detail;
          setMessages(detail.messages ?? []);
          setTasks(await withLiveTaskStatus(detail.tasks ?? []));
        }
      } catch { /* Keep the last known conversation when offline. */ }
    };
    void refresh();
    const timer = setInterval(() => { void refresh(); }, 12_000);
    return () => { active = false; clearInterval(timer); };
  }, [conversationId]);

  async function send(event: FormEvent) {
    event.preventDefault();
    const text = draft.trim();
    if (!text || sending) return;
    setDraft("");
    setSending(true);
    setNotice("");
    try {
      const mode = taskMode(text);
      if (mode && repository) {
        const response = await fetch("/api/tasks", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ repository, branch, mode, objective: text, conversationId }),
        });
        const result = await response.json() as { conversationId?: string; message?: string };
        if (!response.ok) { setNotice(result.message ?? "Atlas could not start that task."); return; }
        if (result.conversationId) { setConversationId(result.conversationId); await openThread(result.conversationId); }
        setVersion((value) => value + 1);
        return;
      }
      const localId = `local-${Date.now()}`;
      setMessages((items) => [...items, { id: localId, role: "user", content: text, createdAt: new Date().toISOString() }]);
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ conversationId, message: text }),
      });
      const result = await response.json() as { conversationId?: string; reply?: Message; message?: string; needsModelEndpoint?: boolean };
      if (!response.ok) {
        setNotice(result.message ?? "Atlas could not answer.");
        if (result.needsModelEndpoint) setReady({ configured: false, reason: result.message ?? null });
        return;
      }
      if (result.conversationId) setConversationId(result.conversationId);
      if (result.reply) setMessages((items) => [...items, result.reply!]);
      setVersion((value) => value + 1);
    } catch {
      setNotice("Chat is temporarily unavailable.");
    } finally {
      setSending(false);
    }
  }

  function keyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void send(event as unknown as FormEvent); }
  }

  const blocked = ready?.configured === false;

  return <AtlasShell
    section="chat"
    rail={<ThreadRail threads={threads} activeId={conversationId} newLabel="New chat" emptyLabel="Nothing yet. Ask Atlas anything."
      onNew={startNew} onOpen={(id) => void openThread(id)} onClose={(id) => void close(id).then((done) => { if (done && id === conversationId) startNew(); })} />}
    headerContext={<span className="context-chip">{ready === null ? "Checking model…" : ready.configured ? "Model connected" : "No model endpoint"}</span>}
  >
    <div className="section-scroll">
      {messages.length === 0 ? <div className="section-empty">
        <div className="empty-mark"><AtlasMark /></div>
        <p className="kicker">CHAT</p>
        <h1>What can I help you get done?</h1>
        <p>Ask a question, describe a project, or tell Atlas what you want done. Atlas will answer here or start an approved task for the selected project.</p>
        <div className="starter-grid">
          {STARTERS.map((item) => <button key={item.title} onClick={() => setDraft(item.prompt)}>
            {item.title}<span>Fills the box below</span>
          </button>)}
        </div>
      </div> : <div className="message-stream">
        {messages.map((item) => item.role === "user"
          ? <div className="user-message" key={item.id}><p>{item.content}</p></div>
          : <div className="atlas-message" key={item.id}><div className="assistant-avatar"><AtlasMark /></div><div><b>Atlas</b><p>{item.content}</p></div></div>)}
        {sending && <div className="atlas-message"><div className="assistant-avatar"><AtlasMark /></div><div><b>Atlas</b><p className="thinking">Thinking…</p></div></div>}
        {tasks.map((task) => <div className="atlas-message task-update" key={task.taskId}><div className="assistant-avatar"><AtlasMark /></div><div><b>Atlas</b><p>{taskStatusLabel(task)}</p><small>{task.mode === "coder" ? "I will return a pull request for your review." : "I will return a report when the task finishes."}</small><div className="result-links">{task.pullRequest?.url && <a className="result-link" href={task.pullRequest.url} target="_blank" rel="noreferrer">Review the pull request ↗</a>}{task.run?.url && <a className="result-link" href={task.run.url} target="_blank" rel="noreferrer">Open task details ↗</a>}</div></div></div>)}
      </div>}
      <div ref={endRef} />
    </div>
    <form className="chat-composer" onSubmit={send}>
      {blocked && <p className="composer-blocked">
        Questions need an AI model connection. Project tasks can still start when a project is connected. {ready?.reason} <Link href="/setup">Open Connections →</Link>
      </p>}
      <textarea aria-label="Message Atlas" value={draft} rows={3} onKeyDown={keyDown}
        onChange={(event) => setDraft(event.target.value)}
      placeholder={blocked ? "Connect an AI model before asking Atlas a question" : "Ask Atlas anything, or describe what you want to get done…"} />
      <div className="composer-actions">
        <div><span className="composer-hint">Enter sends · Shift+Enter for a new line</span></div>
        <button className="send" disabled={sending || !draft.trim()}>{sending ? "…" : "↑"}</button>
      </div>
      {notice && <p className="composer-notice" role="status">{notice}</p>}
    </form>
  </AtlasShell>;
}
