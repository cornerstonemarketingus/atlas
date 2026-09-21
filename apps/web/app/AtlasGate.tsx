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
      <p className="signin-kicker">AI COMPUTER OPERATOR + AUTONOMOUS BUILDER</p>
      <h1>Give Atlas a goal.<br />It builds—and operates—the result.</h1>
      <p>Atlas writes and verifies software, then works across websites and business tools to help launch, sell, market, and operate what you built—with approval before consequential actions.</p>
      <p className="signin-demo-link"><a href="/computer">Explore the computer operator →</a></p>
    </div>
    <div className="signin-proof"><span>Build real software</span><span>Operate websites and tools</span><span>Approve every consequence</span></div>
  </section><section className="signin-access"><div>
    <p className="signin-kicker">START FREE</p>
    <h2>Your product team and computer operator.</h2>
    <p>Connect GitHub to start building. Verified owners receive unrestricted personal access automatically; the private access code remains available as a fallback.</p>
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
