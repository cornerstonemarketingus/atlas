"use client";
import { FormEvent, useState } from "react";

export function OwnerAccess() {
  const [showCode, setShowCode] = useState(false);
  const [accessCode, setAccessCode] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  async function unlock(event: FormEvent) {
    event.preventDefault();
    setBusy(true); setNotice("");
    try {
      const response = await fetch("/api/auth/operator", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ accessCode: accessCode.trim() }) });
      const result = await response.json().catch(() => ({})) as { message?: string };
      if (response.ok) { window.location.href = "/computer"; return; }
      setNotice(result.message ?? "Owner access could not be verified.");
    } catch { setNotice("Owner access is temporarily unavailable."); }
    finally { setBusy(false); }
  }

  return <section className="owner-card"><small>OWNER SIGN-IN</small><h2>Continue to your private Atlas.</h2><p>Your explicitly approved GitHub login receives the deployment-owner role.</p><a className="owner-primary" href="/api/auth/github/start">Continue with GitHub <span>→</span></a><button type="button" className="owner-secondary" onClick={() => setShowCode((value) => !value)}>Use private access code</button>{showCode && <form onSubmit={(event) => void unlock(event)}><label htmlFor="owner-access-code">Private access code</label><input id="owner-access-code" type="password" value={accessCode} onChange={(event) => setAccessCode(event.target.value)} autoComplete="off" required /><button disabled={busy}>{busy ? "Verifying…" : "Unlock owner workspace"}</button></form>}{notice && <p role="status" className="notice">{notice}</p>}<small>Owner sessions remain subject to Atlas approval, audit, and repository policies.</small></section>;
}
