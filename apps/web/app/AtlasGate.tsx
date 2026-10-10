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
      <p className="signin-kicker">AUTONOMOUS SOFTWARE PLATFORM</p>
      <h1>Ask it. Atlas does the work.</h1>
      <p>From an idea to working software. Build repositories, websites and apps, coordinate child agents, and put your computer to work. Atlas brings creation, verified execution and persistent automation into one platform—with you in control of consequential actions.</p>
      <div className="atlas-pipeline" aria-label="Atlas workflow"><span>Your goal</span><span>Create</span><span>Verify</span><span>Operate</span><span>Grow</span></div>
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
      <article><small>01 / CREATE</small><b>Build working software</b><p>Repositories, websites, web apps and APIs. Atlas edits code, checks the result and prepares changes you can review.</p></article>
      <article><small>02 / COORDINATE</small><b>Work with child agents</b><p>Local mission teams and isolated coding lanes divide complex work, retain evidence and bring results back to the parent agent.</p></article>
      <article><small>03 / EXECUTE</small><b>Control your computer</b><p>Pair your Windows PC for remote browser and computer tasks, with approvals and a record of consequential actions.</p></article>
      <article><small>04 / OPERATE</small><b>Keep moving forward</b><p>Persistent missions, memory and scheduled automation support ongoing work. Complete business creation and dedicated game workflows are the larger direction.</p></article>
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
