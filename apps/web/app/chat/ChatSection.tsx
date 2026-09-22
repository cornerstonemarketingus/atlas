"use client";
import Link from "next/link";
import { FormEvent, useEffect, useRef, useState } from "react";
import { AtlasMark } from "../AtlasMark.js";
import { AtlasShell } from "../AtlasShell.js";
import { ThreadRail, useThreads } from "../ThreadRail.js";

type Message = { id: string; role: string; content: string; createdAt: string };
type Detail = { messages?: Message[]; tasks?: { taskId: string; objective: string; mode: string }[] };

const STARTERS = [
  { title: "Plan a product", prompt: "Help me plan a small web app. Ask me what it needs to do, then propose the smallest first version." },
  { title: "Decide an approach", prompt: "I need to choose between two approaches. Ask me what they are, then argue both sides honestly." },
  { title: "Understand something", prompt: "Explain how this project's task dispatch works, in plain language, step by step." },
];

/**
 * Chat: the section for thinking, before anything is built or operated.
 *
 * It writes nothing and runs nothing, which is exactly why it exists — the
 * previous interface had one composer that dispatched a CI job for every
 * sentence you typed, so there was no way to just ask a question.
 */
export function ChatSection() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState("");
  const [conversationId, setConversationId] = useState<string | null>(null);
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

  useEffect(() => { endRef.current?.scrollIntoView({ block: "end" }); }, [messages, sending]);

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
    } catch {
      setNotice("That thread's history could not be loaded.");
    }
  }

  function startNew() { setConversationId(null); setMessages([]); setDraft(""); setNotice(""); }

  async function send(event: FormEvent) {
    event.preventDefault();
    const text = draft.trim();
    if (!text || sending) return;
    const localId = `local-${Date.now()}`;
    setMessages((items) => [...items, { id: localId, role: "user", content: text, createdAt: new Date().toISOString() }]);
    setDraft("");
    setSending(true);
    setNotice("");
    try {
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
        <h1>Think it through.</h1>
        <p>Ask questions, plan an approach, or work out what you actually want. Nothing here changes code or touches your computer — hand it to <Link href="/build">Build</Link> or <Link href="/automation">Automation</Link> when you are ready to act.</p>
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
      </div>}
      <div ref={endRef} />
    </div>
    <form className="chat-composer" onSubmit={send}>
      {blocked && <p className="composer-blocked">
        Chat has no model endpoint yet, so Atlas cannot answer. {ready?.reason} <Link href="/setup">Open Connections →</Link>
      </p>}
      <textarea aria-label="Message Atlas" value={draft} rows={3} onKeyDown={keyDown}
        onChange={(event) => setDraft(event.target.value)}
        placeholder={blocked ? "Chat needs a model endpoint before it can answer" : "Ask Atlas anything…"} />
      <div className="composer-actions">
        <div><span className="composer-hint">Enter sends · Shift+Enter for a new line</span></div>
        <button className="send" disabled={sending || !draft.trim() || blocked}>{sending ? "…" : "↑"}</button>
      </div>
      {notice && <p className="composer-notice" role="status">{notice}</p>}
    </form>
  </AtlasShell>;
}
