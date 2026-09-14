"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { AtlasMark } from "../AtlasMark.js";

type SetupStep = { id: string; label: string; state: "complete" | "action-required" | "failed"; detail: string; action?: string };
type SetupStatus = { overall: string; completedSteps: number; totalSteps: number; steps: SetupStep[]; optional: { stripeConfigured: boolean } };

export function SetupCenter() {
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [error, setError] = useState("");
  const refresh = () => fetch("/api/setup/status", { cache: "no-store" })
    .then(async (response) => {
      if (response.status === 401) { window.location.href = "/"; return null; }
      if (!response.ok) throw new Error("Setup readiness is temporarily unavailable.");
      return response.json() as Promise<SetupStatus>;
    })
    .then((value) => { if (value) setStatus(value); })
    .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "Setup readiness is temporarily unavailable."));

  useEffect(() => { void refresh(); }, []);

  return <main className="setup-shell">
    <header className="setup-header"><Link className="brand" href="/"><span className="brandmark"><AtlasMark /></span>ATLAS</Link><Link href="/">Back to tasks</Link></header>
    <section className="setup-intro">
      <div className="eyebrow"><span>SETUP</span> Remote control center</div>
      <h1>Bring Atlas online<br /><em>from anywhere.</em></h1>
      <p>Eight checks cover GitHub, Cloudflare, the database, runtime credentials, deployment, and sign-in. Completed checks stay complete when you return on another device.</p>
      <div className="setup-progress" aria-live="polite"><strong>{status ? `${status.completedSteps}/${status.totalSteps}` : "…"}</strong><span>{status?.overall === "ready" ? "Ready" : "setup checks complete"}</span></div>
    </section>
    <section className="setup-list" aria-label="Atlas setup checklist">
      {error && <p className="notice" role="alert">{error}</p>}
      {!status && !error && <p>Checking the live environment…</p>}
      {status?.steps.map((item, index) => <article className={`setup-card ${item.state}`} key={item.id}>
        <div className="setup-number">{String(index + 1).padStart(2, "0")}</div>
        <div><div className="setup-state">{item.state.replace("-", " ")}</div><h2>{item.label}</h2><p>{item.detail}</p></div>
        {item.state !== "complete" && <span className="setup-action">{item.action ?? "Action required"}</span>}
      </article>)}
      {status && <article className="setup-card optional"><div className="setup-number">+</div><div><div className="setup-state">Optional</div><h2>Stripe billing</h2><p>{status.optional.stripeConfigured ? "Billing credentials are configured." : "Add billing when you are ready to charge customers."}</p></div></article>}
    </section>
    <div className="setup-toolbar"><button type="button" onClick={() => void refresh()}>REFRESH LIVE STATUS</button></div>
  </main>;
}
