"use client";
import { useCallback, useEffect, useState } from "react";

export type Thread = { id: string; title: string; repository: string; branch: string; updatedAt: string };

/**
 * The recent-threads list in the rail. Chat and Build share one thread store —
 * a conversation can hold both a discussion and the builds that came out of
 * it — so they share this list rather than each keeping a private one.
 */
export function useThreads(refreshKey: unknown) {
  const [threads, setThreads] = useState<Thread[]>([]);
  const load = useCallback((keep: () => boolean = () => true) => fetch("/api/conversations", { cache: "no-store" })
    .then((response) => (response.ok ? response.json() : null))
    .then((value: { conversations?: Thread[] } | null) => { if (keep() && value?.conversations) setThreads(value.conversations); })
    .catch(() => undefined), []);
  useEffect(() => { let active = true; void load(() => active); return () => { active = false; }; }, [load, refreshKey]);
  const close = useCallback(async (id: string) => {
    const response = await fetch(`/api/conversations/${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => null);
    if (!response?.ok) return false;
    setThreads((items) => items.filter((item) => item.id !== id));
    return true;
  }, []);
  return { threads, reload: load, close };
}

type Props = {
  readonly threads: readonly Thread[];
  readonly activeId: string | null;
  readonly newLabel: string;
  readonly emptyLabel: string;
  readonly onNew: () => void;
  readonly onOpen: (id: string) => void;
  readonly onClose: (id: string) => void;
};

export function ThreadRail({ threads, activeId, newLabel, emptyLabel, onNew, onOpen, onClose }: Props) {
  const [query, setQuery] = useState("");
  const visibleThreads = threads.filter((item) => `${item.title} ${item.repository}`.toLowerCase().includes(query.trim().toLowerCase()));
  return <div className="rail-threads">
    <button className="new-thread" onClick={onNew}><b>＋</b> {newLabel}</button>
    <label className="thread-search"><span className="sr-only">Search conversations</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search" /></label>
    <p className="sidebar-label">Chats</p>
    <div className="thread-list">
      {visibleThreads.map((item) => <div className={item.id === activeId ? "active" : ""} key={item.id}>
        <button className="thread-open" onClick={() => onOpen(item.id)}>
          <span>{item.title || "Untitled thread"}</span><small>{item.repository || "No project"}</small>
        </button>
        <button className="thread-close" aria-label={`Close ${item.title}`} title="Close thread" onClick={() => onClose(item.id)}>×</button>
      </div>)}
      {visibleThreads.length === 0 && <p className="thread-empty">{query ? "No conversations found." : emptyLabel}</p>}
    </div>
  </div>;
}
