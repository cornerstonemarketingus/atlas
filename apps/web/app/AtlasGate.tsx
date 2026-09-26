"use client";
import { FormEvent, ReactNode, useEffect, useState } from "react";
import { AtlasMark } from "./AtlasMark.js";
import { MarketingNav } from "./MarketingNav.js";

/**
 * The sign-in gate that wraps every signed-in section.
 *
 * Renders the gate both before the account check resolves and after it
 * confirms the visitor isn't signed in — useEffect never runs during server
 * rendering, so treating "not yet known" as "not signed in" is what keeps the
 * server-rendered HTML meaningful instead of a blank loading stub.
 */
export function AtlasGate({ children }: { readonly children: ReactNode }) {
  const [signedIn, setSignedIn] = useState(false);
  const [showAccessCode, setShowAccessCode] = useState(false);
  const [tokenInput, setTokenInput] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    let active = true;
    void fetch("/api/account")
      .then((response) => (response.ok ? response.json() : { signedIn: false }))
      .catch(() => ({ signedIn: false }))
      .then((value) => { if (active) setSignedIn((value as { signedIn?: boolean }).signedIn === true); });
    return () => { active = false; };
  }, []);

  async function unlock(event: FormEvent) {
    event.preventDefault();
    if (!tokenInput.trim()) return;
    const response = await fetch("/api/auth/operator", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ accessCode: tokenInput.trim() }),
    });
    if (response.ok) { setTokenInput(""); window.location.reload(); return; }
    const result = await response.json().catch(() => ({})) as { message?: string };
    setNotice(result.message ?? "That access code could not be verified.");
  }

  if (signedIn) return <>{children}</>;

  return <main id="top"><MarketingNav /><div className="signin-shell"><section className="signin-story">
    <div className="workspace-brand"><span><AtlasMark /></span>ATLAS</div>
    <div>
      <p className="signin-kicker">AUTONOMOUS AI WORKSPACE</p>
      <h1>Build it.<br />Run it.<br />Grow it.</h1>
      <p>Atlas is an autonomous AI workspace that builds software, operates computers and turns successful work into persistent automations — and pauses for you before anything consequential.</p>
      <p className="signin-demo-link"><a href="/product">See how Atlas works →</a></p>
    </div>
    <div className="signin-proof"><span>Create software</span><span>Operate your computer</span><span>Automate the work</span></div>
  </section><section className="signin-access"><div>
    <p className="signin-kicker">START FREE</p>
    <h2>Go beyond the coding assistant.</h2>
    <p>Sign in with GitHub to chat with Atlas, connect the projects you want built and improved, and pair the computer you want it to operate. You approve every consequential action.</p>
    <div className="signin-actions">
      <a href="/api/auth/github/start" className="signin-primary">Continue securely <span>→</span></a>
      {!showAccessCode && <button type="button" onClick={() => setShowAccessCode(true)} className="signin-secondary">Owner access code</button>}
      {showAccessCode && <form onSubmit={(event) => void unlock(event)} className="access-code-form">
        <label htmlFor="operator-token">Owner access code</label>
        <div><input id="operator-token" type="password" value={tokenInput} onChange={(event) => setTokenInput(event.target.value)} placeholder="Paste your private code" autoComplete="off" /><button>Unlock</button></div>
      </form>}
      {notice && <p className="notice" role="status">{notice}</p>}
    </div>
    <small>By continuing, you agree to the <a href="/legal/terms">Terms</a> and <a href="/legal/privacy">Privacy Policy</a>. <a href="/pricing">View pricing</a>.</small>
  </div></section></div></main>;
}
