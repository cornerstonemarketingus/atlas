"use client";
import Link from "next/link";
import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { AtlasShell } from "../AtlasShell.js";

type DeletionRequest = { status: string; requestedAt: string };
type Account = {
  signedIn: boolean; githubLogin?: string | null; tier?: "free" | "pro" | "team" | null;
  status?: string; unrestricted?: boolean; usage?: { used: number; limit: number };
};

const TIER_LABELS: Record<string, string> = { free: "Free", pro: "Pro", team: "Team" };

function deletionReceipt(value: unknown): DeletionRequest | null {
  if (value === null) return null;
  if (!value || typeof value !== "object") throw new Error("Invalid deletion receipt");
  const row = value as Partial<DeletionRequest>;
  if (!["pending", "completed", "rejected"].includes(row.status ?? "") || typeof row.requestedAt !== "string" || !Number.isFinite(Date.parse(row.requestedAt))) throw new Error("Invalid deletion receipt");
  return { status: row.status!, requestedAt: row.requestedAt };
}

/** Settings: the plan, the privacy controls, and the way out. */
export function AccountPrivacy() {
  const [theme, setTheme] = useState<"system" | "light" | "dark">(() => {
    if (typeof window === "undefined") return "system";
    const saved = window.localStorage.getItem("atlas-theme");
    return saved === "light" || saved === "dark" ? saved : "system";
  });
  const [account, setAccount] = useState<Account | null>(null);
  const [request, setRequest] = useState<DeletionRequest | null>(null);
  const [confirmation, setConfirmation] = useState("");
  const [notice, setNotice] = useState("");
  const [billingNotice, setBillingNotice] = useState("");
  const [billingBusy, setBillingBusy] = useState(false);
  const [deletionBusy, setDeletionBusy] = useState(false);
  const deletionInFlight = useRef(false);
  const [deletionStatus, setDeletionStatus] = useState<"loading" | "ready" | "unavailable">("loading");
  const deletionRead = useRef(0);
  const deletionController = useRef<AbortController | null>(null);

  const refreshDeletionStatus = useCallback(async () => {
    if (deletionInFlight.current) return;
    const version = ++deletionRead.current;
    deletionController.current?.abort();
    const controller = new AbortController();
    deletionController.current = controller;
    const deadline = window.setTimeout(() => controller.abort(), 12000);
    setDeletionStatus("loading");
    try {
      const response = await fetch("/api/account/deletion", { signal: controller.signal });
      if (version !== deletionRead.current) return;
      if (response.status === 401) { window.location.href = "/"; return; }
      if (!response.ok) throw new Error("Deletion status unavailable");
      const data = await response.json();
      if (version !== deletionRead.current) return;
      setRequest(deletionReceipt(data?.request));
      setDeletionStatus("ready"); setNotice("");
    } catch {
      if (version !== deletionRead.current) return;
      setDeletionStatus("unavailable");
      setNotice("We could not load your deletion status. Refresh the status before submitting another request.");
    } finally { window.clearTimeout(deadline); }
  }, []);

  useEffect(() => {
    document.documentElement.dataset.atlasTheme = theme;
  }, [theme]);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void fetch("/api/account", { signal: controller.signal }).then((response) => (response.ok ? response.json() : null))
        .then((value) => { if (!controller.signal.aborted && value) setAccount(value as Account); }).catch(() => undefined);
      void refreshDeletionStatus();
    }, 0);
    return () => {
      window.clearTimeout(timer); controller.abort();
      deletionRead.current += 1; deletionController.current?.abort();
    };
  }, [refreshDeletionStatus]);

  function changeTheme(next: "system" | "light" | "dark") {
    setTheme(next); window.localStorage.setItem("atlas-theme", next); document.documentElement.dataset.atlasTheme = next;
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (deletionInFlight.current || deletionStatus !== "ready" || confirmation !== "DELETE") return;
    deletionInFlight.current = true;
    deletionRead.current += 1; deletionController.current?.abort();
    setDeletionStatus("loading");
    setDeletionBusy(true); setNotice("");
    const controller = new AbortController();
    const deadline = window.setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch("/api/account/deletion", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirmation }), signal: controller.signal,
      });
      if (!response.ok) {
        setDeletionStatus("unavailable");
        setNotice(response.status === 401 ? "Sign in again to request account deletion." : "We could not confirm your deletion request. Refresh deletion status before trying again.");
        return;
      }
      const data = await response.json();
      const receipt = deletionReceipt(data?.request);
      if (receipt?.status !== "pending") throw new Error("Invalid deletion receipt");
      setRequest(receipt); setDeletionStatus("ready");
      setNotice("Deletion requested. We will remove eligible account data within 30 days.");
    } catch {
      setDeletionStatus("unavailable");
      setNotice("We could not confirm your deletion request. Refresh deletion status before trying again.");
    } finally {
      window.clearTimeout(deadline);
      deletionInFlight.current = false; setDeletionBusy(false);
    }
  }

  async function billing(action: "checkout" | "portal", tier?: "pro" | "team") {
    setBillingBusy(true); setBillingNotice("");
    try {
      const response = await fetch(`/api/billing/${action}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: action === "checkout" ? JSON.stringify({ tier }) : undefined,
      });
      if (!response.ok) {
        setBillingNotice(response.status === 401 ? "Sign in again to manage billing." : "Billing is temporarily unavailable. Try again shortly.");
        return;
      }
      const result = await response.json() as { url?: string };
      if (typeof result?.url === "string" && new URL(result.url).protocol === "https:") { window.location.href = result.url; return; }
      setBillingNotice("Billing is temporarily unavailable. Try again shortly.");
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

        <section className="page-block">
          <h2><span>01</span>Appearance</h2>
          <p className="block-hint">Choose how Atlas looks on this device.</p>
          <label className="settings-choice">Theme<select aria-label="Theme" value={theme} onChange={(event) => changeTheme(event.target.value as "system" | "light" | "dark")}><option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option></select></label>
        </section>

        {!account?.unrestricted && <section className="page-block">
          <h2><span>02</span>Plan</h2>
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
          {deletionStatus === "loading" && !deletionBusy && <p role="status">Checking deletion status…</p>}
          {deletionStatus === "unavailable" && <button type="button" onClick={() => void refreshDeletionStatus()}>Refresh deletion status</button>}
          {request?.status === "pending"
            ? <p className="page-notice" role="status">Deletion requested on {new Date(request.requestedAt).toLocaleDateString()}. Eligible data will be removed within 30 days.</p>
            : <>
              <p className="block-hint">This deletes your Atlas account and its task, device, and preference data. Billing and security records may be retained where the law requires it.</p>
              <form className="danger-form" onSubmit={submit}>
                <label>Type DELETE to confirm
                  <input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} autoComplete="off" enterKeyHint="done" />
                </label>
                <button disabled={confirmation !== "DELETE" || deletionBusy || deletionStatus !== "ready"}>{deletionBusy ? "Requesting deletion…" : "Request account deletion"}</button>
              </form>
            </>}
          {notice && <p className="page-notice" role="status">{notice}</p>}
        </section>
      </div>
    </div>
  </AtlasShell>;
}
