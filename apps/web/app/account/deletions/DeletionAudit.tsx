"use client";
import Link from "next/link";
import { FormEvent, useCallback, useEffect, useState } from "react";

type Item = { id: string; requestedBy: string; status: string; requestedAt: string; completedAt?: string | null; processedBy?: string | null; processingNote?: string | null };
export function DeletionAudit() {
  const [items, setItems] = useState<Item[]>([]), [error, setError] = useState(""), [busy, setBusy] = useState("");
  const refresh = useCallback(() => fetch("/api/account/deletion/operator", { cache: "no-store" }).then(async response => {
    const data = await response.json(); if (!response.ok) throw new Error(data.message || "Unable to load deletion requests."); setItems(data.requests);
  }).catch(reason => setError(reason instanceof Error ? reason.message : "Unable to load deletion requests.")), []);
  useEffect(() => { void refresh(); }, [refresh]);
  async function decide(event: FormEvent<HTMLFormElement>, item: Item) {
    event.preventDefault(); const form = new FormData(event.currentTarget); setBusy(item.id); setError("");
    const response = await fetch(`/api/account/deletion/operator/${encodeURIComponent(item.id)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: form.get("action"), confirmation: form.get("confirmation"), note: form.get("note") }) });
    const data = await response.json(); setBusy(""); if (!response.ok) return setError(data.message || "The request could not be processed."); void refresh();
  }
  return <main className="legal-page"><Link href="/account">← Account &amp; privacy</Link><h1>Deletion audit</h1><p>Operator-only queue. Completion permanently removes eligible account data. The minimal request record remains as an audit receipt without a user foreign key.</p>{error && <p role="alert">{error}</p>}{items.length === 0 && !error && <p>No deletion requests.</p>}{items.map(item => <article key={item.id}><h2>{item.status} · {new Date(item.requestedAt).toLocaleString()}</h2><p><code>{item.id}</code><br />Principal: {item.requestedBy}</p>{item.status === "pending" ? <form onSubmit={event => void decide(event, item)}><label>Decision<select name="action" defaultValue="complete"><option value="complete">Complete deletion</option><option value="reject">Reject request</option></select></label><label>Audit note<textarea name="note" maxLength={500} /></label><label>Enter request ID to confirm<input name="confirmation" autoComplete="off" required /></label><button disabled={busy === item.id}>{busy === item.id ? "Processing…" : "Record decision"}</button></form> : <p>Processed {item.completedAt ? new Date(item.completedAt).toLocaleString() : "—"} by {item.processedBy ?? "—"}. {item.processingNote}</p>}</article>)}</main>;
}
