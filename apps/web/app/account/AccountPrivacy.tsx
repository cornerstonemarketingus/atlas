"use client";
import Link from "next/link";
import { FormEvent, useEffect, useState } from "react";
import { AtlasShell } from "../AtlasShell.js";

type DeletionRequest = { status: string; requestedAt: string };
type Account = {
  signedIn: boolean; githubLogin?: string | null; tier?: "free" | "pro" | "team" | null;
  status?: string; unrestricted?: boolean; usage?: { used: number; limit: number };
};

const TIER_LABELS: Record<string, string> = { free: "Free", pro: "Pro", team: "Team" };

/** Settings: the plan, the privacy controls, and the way out. */
export function AccountPrivacy() {
  const [account, setAccount] = useState<Account | null>(null);
  const [request, setRequest] = useState<DeletionRequest | null>(null);
  const [confirmation, setConfirmation] = useState("");
  const [notice, setNotice] = useState("");
  const [billingNotice, setBillingNotice] = useState("");
  const [billingBusy, setBillingBusy] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void fetch("/api/account").then((response) => (response.ok ? response.json() : null))
        .then((value) => { if (value) setAccount(value as Account); }).catch(() => undefined);
      void fetch("/api/account/deletion").then(async (response) => {
        if (response.status === 401) { window.location.href = "/"; return; }
        if (response.ok) setRequest((await response.json()).request);
      }).catch(() => undefined);
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const response = await fetch("/api/account/deletion", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirmation }),
    });
    const data = await response.json();
    if (!response.ok) { setNotice(data.message); return; }
    setRequest(data.request);
    setNotice("Deletion requested. We will remove eligible account data within 30 days.");
  }

  async function billing(action: "checkout" | "portal", tier?: "pro" | "team") {
    setBillingBusy(true); setBillingNotice("");
    try {
      const response = await fetch(`/api/billing/${action}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: action === "checkout" ? JSON.stringify({ tier }) : undefined,
      });
      const result = await response.json() as { url?: string; message?: string };
      if (response.ok && result.url) { window.location.href = result.url; return; }
      setBillingNotice(result.message ?? "The billing service did not respond with a link.");
    } catch {
      setBillingNotice("The billing service is temporarily unavailable.");
    } finally {
      setBillingBusy(false);
    }
  }

  const tier = account?.tier ?? "free";

  return <AtlasShell section="settings" headerContext={
    <span className="context-chip">{account?.unrestricted ? "Owner access" : TIER_LABELS[tier] ?? "Free"}</span>
  }>
    <div className="section-scroll">
      <div className="section-page">
        <header className="page-head">
          <p className="kicker">SETTINGS</p>
          <h1>Your account.</h1>
          <p>What you are on, what you have used, and how to take your data back out.</p>
        </header>

        {!account?.unrestricted && <section className="page-block">
          <h2><span>01</span>Plan</h2>
          <div className="plan-card">
            <div>
              <strong>{TIER_LABELS[tier] ?? "Free"}{account?.status === "past_due" ? " — payment past due" : ""}</strong>
              {account?.usage && <p>{account.usage.used} of {account.usage.limit} builds used this month.</p>}
            </div>
            <div className="plan-actions">
              {tier !== "team" && <button disabled={billingBusy} onClick={() => void billing("checkout", tier === "pro" ? "team" : "pro")}>
                {tier === "pro" ? "Upgrade to Team" : "Upgrade to Pro"}
              </button>}
              {(tier === "pro" || tier === "team") && <button className="quiet" disabled={billingBusy} onClick={() => void billing("portal")}>Manage billing</button>}
              <Link className="quiet-link" href="/pricing">Compare plans →</Link>
            </div>
          </div>
          {billingNotice && <p className="page-notice" role="status">{billingNotice}</p>}
        </section>}

        <section className="page-block">
          <h2><span>{account?.unrestricted ? "01" : "02"}</span>Privacy</h2>
          <p className="block-hint">
            <Link href="/legal/privacy">Privacy policy</Link> · <Link href="/legal/terms">Terms</Link> · <Link href="/delete-account">Deletion help</Link>
          </p>
        </section>

        <section className="page-block">
          <h2><span>{account?.unrestricted ? "02" : "03"}</span>Delete account</h2>
          {request?.status === "pending"
            ? <p className="page-notice" role="status">Deletion requested on {new Date(request.requestedAt).toLocaleDateString()}. Eligible data will be removed within 30 days.</p>
            : <>
              <p className="block-hint">This deletes your Atlas account and its task, device, and preference data. Billing and security records may be retained where the law requires it.</p>
              <form className="danger-form" onSubmit={submit}>
                <label>Type DELETE to confirm
                  <input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} autoComplete="off" enterKeyHint="done" />
                </label>
                <button disabled={confirmation !== "DELETE"}>Request account deletion</button>
              </form>
            </>}
          {notice && <p className="page-notice" role="status">{notice}</p>}
        </section>
      </div>
    </div>
  </AtlasShell>;
}
