"use client";
import Link from "next/link";
import { FormEvent, ReactNode, useEffect, useState } from "react";
import { MarketingFooter, MarketingNav } from "./MarketingNav.js";

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

  return <main id="top" className="landing"><MarketingNav /><div className="signin-shell"><section className="signin-story">
    <div>
      <p className="signin-kicker">AI ASSISTANT FOR BUILDERS</p>
      <h1>Ask it. Atlas does the work.</h1>
      <p>Chat with Atlas like any AI assistant. When you ask it to build or fix something, it changes the code in your GitHub project and opens a pull request. When you ask it to do something online, it uses a browser on your computer and asks you before anything important.</p>
    </div>
    <div className="signin-proof"><span>Writes and tests code</span><span>Does browser tasks</span><span>Asks before important actions</span></div>
  </section><section className="signin-access"><div>
    <p className="signin-kicker">SIGN IN</p>
    <h2>Start free</h2>
    <p>Sign in with your GitHub account. You choose which projects Atlas can work on.</p>
    <div className="signin-actions">
      <a href="/api/auth/github/start" className="signin-primary">Continue with GitHub <span>→</span></a>
      {!showAccessCode && <button type="button" onClick={() => setShowAccessCode(true)} className="signin-secondary">I have an owner access code</button>}
      {showAccessCode && <form onSubmit={(event) => void unlock(event)} className="access-code-form">
        <label htmlFor="operator-token">Owner access code</label>
        <div><input id="operator-token" type="password" value={tokenInput} onChange={(event) => setTokenInput(event.target.value)} placeholder="Paste your code" autoComplete="off" /><button>Unlock</button></div>
      </form>}
      {notice && <p className="notice" role="status">{notice}</p>}
    </div>
    <small>By signing in you agree to the <a href="/legal/terms">Terms</a> and <a href="/legal/privacy">Privacy Policy</a>. See <a href="/pricing">pricing</a>.</small>
  </div></section></div>
  <section className="landing-section">
    <h2>What Atlas does</h2>
    <div className="landing-cards">
      <article><b>Answers questions</b><p>Ask about your code, your plans, or anything else. Answers stay in your chat history across devices.</p></article>
      <article><b>Writes code</b><p>Say what to build or fix. Atlas edits a copy of your repository, runs your tests, and opens a pull request with the change.</p></article>
      <article><b>Does browser work</b><p>Research, filling in forms, updating listings. Atlas uses a separate browser on your Windows PC and stops to ask before it submits, sends, or buys anything.</p></article>
    </div>
  </section>
  <section className="landing-section">
    <h2>How it works</h2>
    <ol className="landing-steps">
      <li><b>Sign in with GitHub</b><span>Pick the repositories Atlas may work on.</span></li>
      <li><b>Tell Atlas what you want</b><span>In chat, in plain words. For browser work, connect your PC once.</span></li>
      <li><b>Review the result</b><span>A pull request for code, a report for questions, and a receipt for every browser task.</span></li>
    </ol>
    <p className="landing-more"><Link href="/demo">See a full example →</Link></p>
  </section>
  <MarketingFooter />
  </main>;
}
