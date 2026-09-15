"use client";
import Link from "next/link";
import { FormEvent, useEffect, useState } from "react";

type DeletionRequest = { status: string; requestedAt: string };
export function AccountPrivacy() {
  const [request, setRequest] = useState<DeletionRequest | null>(null), [confirmation, setConfirmation] = useState(""), [notice, setNotice] = useState("");
  useEffect(() => { const timer = window.setTimeout(() => void fetch("/api/account/deletion").then(async (response) => { if (response.status === 401) { window.location.href = "/"; return; } if (response.ok) setRequest((await response.json()).request); }), 0); return () => window.clearTimeout(timer); }, []);
  async function submit(event: FormEvent) { event.preventDefault(); const response = await fetch("/api/account/deletion", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ confirmation }) }); const data = await response.json(); if (!response.ok) return setNotice(data.message); setRequest(data.request); setNotice("Deletion requested. We will remove eligible account data within 30 days."); }
  return <main className="legal-page"><Link href="/">← Atlas</Link><h1>Account &amp; privacy</h1><p>Manage your Atlas data and store-required privacy controls.</p><p><Link href="/legal/privacy">Privacy policy</Link> · <Link href="/legal/terms">Terms</Link></p><h2>Delete account</h2>{request?.status === "pending" ? <p role="status">Deletion requested on {new Date(request.requestedAt).toLocaleDateString()}. Eligible data will be removed within 30 days.</p> : <><p>This initiates deletion of your Atlas account and associated task, device, and preference data. Billing and security records may be retained where required.</p><form onSubmit={submit}><label>Type DELETE to confirm<input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} autoComplete="off" /></label><button disabled={confirmation !== "DELETE"}>Request account deletion</button></form></>}{notice && <p role="status">{notice}</p>}</main>;
}
