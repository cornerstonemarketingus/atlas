"use client";
import Link from "next/link";
import { FormEvent, useEffect, useRef, useState } from "react";
import { classifyIntent } from "./intent.mjs";
import { MessageBody } from "./MessageBody.js";
import { createEventParser } from "../api/chat/stream.mjs";
import { AtlasMark } from "../AtlasMark.js";
import { AtlasShell } from "../AtlasShell.js";
import { PROJECT_CHANGE_EVENT, PROJECT_STORAGE_KEY } from "../ProjectSwitcher.js";
import { ThreadRail, useThreads } from "../ThreadRail.js";

type Message = { id: string; role: string; content: string; createdAt: string };
type Task = { taskId: string; objective: string; mode: string; status?: string; repository?: string; branch?: string; run?: { url: string | null } | null; pullRequest?: { url: string | null; number: number; merged: boolean } | null };
type Detail = { messages?: Message[]; tasks?: Task[] };

const STARTERS = [
  { title: "Fix a bug in my project", prompt: "Find the most likely bug in my project, fix it, run the tests, and open a pull request." },
  { title: "Fill in a form on a website", prompt: "Go to " },
  { title: "Explain how my code works", prompt: "Explain how my project is organised and where the main logic lives." },
];

/**
 * The capabilities a conversation is using, shown as context only once they
 * are in use. Nobody picks one up front: Atlas chooses from the request.
 */
function activeCapabilities(conversationId: string | null, tasks: Task[], messages: Message[]) {
  const items: { label: string; href: string }[] = [];
  if (tasks.length && conversationId) items.push({ label: "Code", href: `/build?conversation=${encodeURIComponent(conversationId)}` });
  const pullRequest = tasks.find((task) => task.pullRequest?.url)?.pullRequest?.url;
  if (pullRequest) items.push({ label: "Pull request ↗", href: pullRequest });
  if (messages.some((message) => message.role === "assistant" && message.content.includes("](/automation)"))) items.push({ label: "Computer", href: "/automation" });
  return items;
}

type Suggestion = { text: string; kind: "project_task" | "computer_task"; mode?: string; reason: string };
type Device = { id: string; name: string; status: string; revokedAt: string | null };

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
  const [suggestion, setSuggestion] = useState<Suggestion | null>(null);
  const [streaming, setStreaming] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
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

  useEffect(() => { endRef.current?.scrollIntoView({ block: "end" }); }, [messages, sending, streaming, suggestion]);

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

  function startNew() { abortRef.current?.abort(); setConversationId(null); setMessages([]); setTasks([]); setDraft(""); setNotice(""); setSuggestion(null); setStreaming(null); }

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

  function showLocal(text: string) {
    setMessages((items) => [...items, { id: `local-${Date.now()}`, role: "user", content: text, createdAt: new Date().toISOString() }]);
  }

  /**
   * Every message goes to Atlas, and Atlas decides what it needs: an answer,
   * code work, or work on the person's computer. Only when no model is
   * connected (so nothing can decide) does a keyword guess offer the work as
   * a card to confirm instead.
   */
  async function send(event: FormEvent) {
    event.preventDefault();
    const text = draft.trim();
    if (!text || sending) return;
    setDraft("");
    setNotice("");
    const intent = classifyIntent(text, { hasProject: Boolean(repository) });
    if (ready?.configured === false && (intent.kind === "project_task" || intent.kind === "computer_task")) {
      showLocal(text);
      setSuggestion({ text, kind: intent.kind, mode: "mode" in intent ? intent.mode : undefined, reason: intent.reason });
      return;
    }
    showLocal(text);
    await ask(text);
  }

  async function ask(text: string) {
    setSuggestion(null);
    setSending(true);
    setStreaming("");
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ conversationId, message: text, stream: true }),
        signal: controller.signal,
      });
      if (!response.ok || !response.body || !(response.headers.get("content-type") ?? "").includes("text/event-stream")) {
        const result = await response.json().catch(() => ({})) as { message?: string; needsModelEndpoint?: boolean; conversationId?: string };
        setNotice(result.message ?? "Atlas could not answer.");
        if (result.needsModelEndpoint) setReady({ configured: false, reason: result.message ?? null });
        return;
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const parser = createEventParser();
      let partial = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        for (const item of parser.push(decoder.decode(value, { stream: true }))) {
          const data = item.data as { conversationId?: string; text?: string; message?: string; reply?: Message } | null;
          if (item.type === "meta" && data?.conversationId) setConversationId(data.conversationId);
          else if (item.type === "delta" && data?.text) { partial += data.text; setStreaming(partial); }
          else if (item.type === "error") setNotice(data?.message ?? "Atlas could not finish that reply.");
          else if (item.type === "done" && data?.reply) setMessages((items) => [...items, data.reply!]);
        }
      }
      setVersion((value) => value + 1);
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) setNotice("Chat is temporarily unavailable. Your message was kept above; try again in a moment.");
    } finally {
      abortRef.current = null;
      setStreaming(null);
      setSending(false);
    }
  }

  function stop() { abortRef.current?.abort(); }

  async function startProjectTask(item: Suggestion) {
    setSuggestion(null);
    setSending(true);
    try {
      const response = await fetch("/api/tasks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ repository, branch, mode: item.mode ?? "coder", objective: item.text, conversationId }),
      });
      const result = await response.json() as { conversationId?: string; message?: string };
      if (!response.ok) { setNotice(result.message ?? "Atlas could not start that task."); return; }
      if (result.conversationId) { setConversationId(result.conversationId); await openThread(result.conversationId); }
      setVersion((value) => value + 1);
    } catch {
      setNotice("Atlas could not reach the task service. Nothing was started.");
    } finally {
      setSending(false);
    }
  }

  async function startComputerTask(item: Suggestion) {
    setSuggestion(null);
    setSending(true);
    try {
      const listed = await fetch("/api/computer/devices", { cache: "no-store" });
      const devices = listed.ok ? ((await listed.json()) as { devices?: Device[] }).devices ?? [] : [];
      const usable = devices.filter((device) => !device.revokedAt);
      const device = usable.find((candidate) => candidate.status === "online") ?? usable[0];
      if (!device) { setNotice("No computer is paired yet. Open Computer to pair your PC, then send this again."); return; }
      const response = await fetch("/api/computer/tasks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deviceId: device.id, executionProvider: "windows", objective: item.text }),
      });
      const result = await response.json() as { message?: string };
      if (!response.ok) { setNotice(result.message ?? "Atlas could not start that computer task."); return; }
      setMessages((items) => [...items, { id: `local-${Date.now()}-task`, role: "assistant", createdAt: new Date().toISOString(),
        content: `Started on **${device.name}**${device.status === "online" ? "" : " (it will begin when that computer comes online)"}. I will pause for your approval before anything consequential. Follow it in [Computer](/automation).` }]);
    } catch {
      setNotice("Atlas could not reach the computer service. Nothing was started.");
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
    headerContext={<>
      {activeCapabilities(conversationId, tasks, messages).map((item) => <a key={item.label} className="context-chip capability-chip" href={item.href}
        {...(item.href.startsWith("http") ? { target: "_blank", rel: "noreferrer" } : {})}>{item.label}</a>)}
      {ready?.configured === false && <span className="context-chip">No model connected</span>}
    </>}
  >
    <div className="section-scroll">
      {messages.length === 0 ? <div className="section-empty">
        <div className="empty-mark"><AtlasMark /></div>
        <h1>What do you want to accomplish?</h1>
        <p>Ask a question or describe the outcome. Atlas works out whether it needs to answer, change code, or use your computer.</p>
        <div className="starter-grid">
          {STARTERS.map((item) => <button key={item.title} onClick={() => setDraft(item.prompt)}>
            {item.title}
          </button>)}
        </div>
      </div> : <div className="message-stream">
        {messages.map((item) => item.role === "user"
          ? <div className="user-message" key={item.id}><p>{item.content}</p></div>
          : <div className="atlas-message" key={item.id}><div className="assistant-avatar"><AtlasMark /></div><div><b>Atlas</b><MessageBody text={item.content} /></div></div>)}
        {streaming !== null && <div className="atlas-message" aria-live="polite"><div className="assistant-avatar"><AtlasMark /></div><div><b>Atlas</b>{streaming ? <MessageBody text={streaming} /> : <p className="thinking">Thinking…</p>}</div></div>}
        {sending && streaming === null && <div className="atlas-message"><div className="assistant-avatar"><AtlasMark /></div><div><b>Atlas</b><p className="thinking">Starting…</p></div></div>}
        {suggestion && <div className="atlas-message suggestion-card"><div className="assistant-avatar"><AtlasMark /></div><div>
          <b>Atlas</b>
          <p>{suggestion.reason} {suggestion.kind === "project_task" ? <>It will run on <strong>{repository}</strong> ({branch}).</> : <>It will run on your computer and ask you before anything important.</>}</p>
          <div className="suggestion-actions">
            <button type="button" className="primary" onClick={() => void (suggestion.kind === "project_task" ? startProjectTask(suggestion) : startComputerTask(suggestion))}>
              {suggestion.kind === "project_task" ? (suggestion.mode === "inspect" ? "Start review" : suggestion.mode === "debug" ? "Start debugging" : "Start task") : "Start on my computer"}
            </button>
            <button type="button" className="secondary" onClick={() => void ask(suggestion.text)}>Just answer in chat</button>
          </div>
        </div></div>}
        {tasks.map((task) => <div className="atlas-message task-update" key={task.taskId}><div className="assistant-avatar"><AtlasMark /></div><div><b>Atlas</b><p>{taskStatusLabel(task)}</p><small>{task.mode === "coder" ? "I'll open a pull request when it's done." : "I'll post a report when it's done."}</small><div className="result-links">{task.pullRequest?.url && <a className="result-link" href={task.pullRequest.url} target="_blank" rel="noreferrer">Review the pull request ↗</a>}{task.run?.url && <a className="result-link" href={task.run.url} target="_blank" rel="noreferrer">Open task details ↗</a>}</div></div></div>)}
      </div>}
      <div ref={endRef} />
    </div>
    <form className="chat-composer" onSubmit={send}>
      {blocked && <p className="composer-blocked">
        Questions need an AI model connection. Project and computer tasks can still start. {ready?.reason} <Link href="/setup">Open Connections →</Link>
      </p>}
      <textarea aria-label="Message Atlas" value={draft} rows={3} onKeyDown={keyDown}
        onChange={(event) => setDraft(event.target.value)}
      placeholder={blocked ? "Connect an AI model before asking Atlas a question" : "Ask Atlas anything…"} />
      <div className="composer-actions">
        <div><span className="composer-hint">Enter sends · Shift+Enter for a new line</span></div>
        {streaming !== null
          ? <button type="button" className="send" onClick={stop} aria-label="Stop the reply">■</button>
          : <button className="send" aria-label="Send" disabled={sending || !draft.trim()}>{sending ? "…" : "↑"}</button>}
      </div>
      {notice && <p className="composer-notice" role="status">{notice}</p>}
    </form>
  </AtlasShell>;
}
