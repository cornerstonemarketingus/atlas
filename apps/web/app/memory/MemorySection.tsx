"use client";
import { useEffect, useMemo, useState } from "react";
import { AtlasShell } from "../AtlasShell.js";

type Memory = {
  id: string;
  kind: string;
  repository: string | null;
  content: string;
  updatedAt?: string;
  lastUsedAt?: string | null;
};

export function MemorySection() {
  const [available, setAvailable] = useState(true);
  const [items, setItems] = useState<Memory[]>([]);
  const [search, setSearch] = useState("");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState("");

  async function load(query: string) {
    const response = await fetch(`/api/memory${query ? `?q=${encodeURIComponent(query)}` : ""}`, { cache: "no-store" });
    if (response.status === 401) { window.location.href = "/"; return null; }
    const value = await response.json() as { available: boolean; memories: Memory[]; message?: string };
    return value;
  }

  useEffect(() => {
    let active = true;
    const timer = window.setTimeout(() => {
      void load(search).then((result) => {
        if (!active || !result) return;
        setAvailable(result.available);
        setItems(result.memories);
        setDrafts(Object.fromEntries(result.memories.map((memory) => [memory.id, memory.content])));
        if (!result.available && result.message) setNotice(result.message);
      });
    }, 200);
    return () => { active = false; window.clearTimeout(timer); };
  }, [search]);

  const countLabel = useMemo(() => items.length === 1 ? "1 memory" : `${items.length} memories`, [items.length]);

  async function save(id: string) {
    const content = drafts[id]?.trim() ?? "";
    if (!content) return;
    setBusy(id);
    setNotice("");
    try {
      const response = await fetch("/api/memory", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, content }),
      });
      const value = await response.json() as { memory?: Memory; message?: string };
      if (!response.ok || !value.memory) { setNotice(value.message ?? "That memory could not be updated."); return; }
      setItems((current) => current.map((memory) => memory.id === id ? value.memory as Memory : memory));
      setDrafts((current) => ({ ...current, [id]: value.memory?.content ?? content }));
      setNotice("Memory updated.");
    } catch {
      setNotice("Memory is temporarily unavailable.");
    } finally {
      setBusy(null);
    }
  }

  async function remove(id: string) {
    setBusy(id);
    setNotice("");
    try {
      const response = await fetch("/api/memory", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id }),
      });
      const value = await response.json().catch(() => ({})) as { message?: string };
      if (!response.ok) { setNotice(value.message ?? "That memory could not be deleted."); return; }
      setItems((current) => current.filter((memory) => memory.id !== id));
      setDrafts((current) => {
        const next = { ...current };
        delete next[id];
        return next;
      });
      setNotice("Memory deleted.");
    } catch {
      setNotice("Memory is temporarily unavailable.");
    } finally {
      setBusy(null);
    }
  }

  async function removeAll() {
    if (!window.confirm("Delete every saved memory?")) return;
    setBusy("all");
    setNotice("");
    try {
      const response = await fetch("/api/memory", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ all: true }),
      });
      const value = await response.json().catch(() => ({})) as { message?: string };
      if (!response.ok) { setNotice(value.message ?? "Saved memories could not be deleted."); return; }
      setItems([]);
      setDrafts({});
      setNotice("All memories deleted.");
    } catch {
      setNotice("Memory is temporarily unavailable.");
    } finally {
      setBusy(null);
    }
  }

  return <AtlasShell section="memory" headerContext={<span className="context-chip">{countLabel}</span>}>
    <div className="section-scroll">
      <div className="section-page">
        <header className="page-head">
          <p className="kicker">MEMORY</p>
          <h1>Saved memories.</h1>
          <p>Durable facts, conventions, preferences and decisions Atlas can reuse in later conversations.</p>
        </header>

        <section className="page-block">
          <h2><span>01</span>Search</h2>
          <label className="settings-choice">Find a memory
            <input className="memory-search" aria-label="Search memories" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search facts, commands, conventions…" />
          </label>
          {available && <button type="button" className="page-action quiet-action" disabled={busy === "all" || items.length === 0} onClick={() => void removeAll()}>
            {busy === "all" ? "Deleting…" : "Delete all"}
          </button>}
          {notice && <p className="page-notice" role="status">{notice}</p>}
        </section>

        <section className="page-block">
          <h2><span>02</span>Saved items</h2>
          {!available
            ? <p className="page-notice" role="status">Memory is not set up yet.</p>
            : items.length === 0
              ? <p className="block-hint">No saved memories matched this search.</p>
              : <div className="memory-list">
                {items.map((memory) => <article key={memory.id} className="memory-card">
                  <div className="memory-meta">
                    <strong>{memory.kind}</strong>
                    <span>{memory.repository ?? "shared across this workspace"}</span>
                    <time>{memory.lastUsedAt || memory.updatedAt ? new Date(memory.lastUsedAt ?? memory.updatedAt ?? "").toLocaleString() : "Unknown time"}</time>
                  </div>
                  <textarea value={drafts[memory.id] ?? memory.content} rows={4} maxLength={1000}
                    onChange={(event) => setDrafts((current) => ({ ...current, [memory.id]: event.target.value }))}
                    aria-label={`Edit memory ${memory.id}`}
                  />
                  <div className="memory-actions">
                    <button type="button" onClick={() => void save(memory.id)} disabled={busy === memory.id || !(drafts[memory.id] ?? "").trim()}>
                      {busy === memory.id ? "Saving…" : "Save"}
                    </button>
                    <button type="button" className="quiet" onClick={() => void remove(memory.id)} disabled={busy === memory.id}>Delete</button>
                  </div>
                </article>)}
              </div>}
        </section>
      </div>
    </div>
  </AtlasShell>;
}
