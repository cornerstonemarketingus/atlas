"use client";
import { FormEvent, useEffect, useState } from "react";

const activity = [
  { title: "Repository intelligence foundation", detail: "149 checks passed", status: "Shipped" },
  { title: "GitHub repository host", detail: "Read-only adapter connected", status: "Ready" },
  { title: "Hosted control plane", detail: "Deployment candidate", status: "Building" },
];

const TOKEN_STORAGE_KEY = "atlas-operator-token";

function storedToken(): string {
  try { return localStorage.getItem(TOKEN_STORAGE_KEY) ?? ""; } catch { return ""; }
}

export function AtlasDashboard() {
  const [repository, setRepository] = useState("cornerstonemarketingus/atlas");
  const [branch, setBranch] = useState("main");
  const [mode, setMode] = useState("inspect");
  const [objective, setObjective] = useState("");
  const [notice, setNotice] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [github, setGitHub] = useState<{ connected: boolean; method: string; installUrl: string | null } | null>(null);
  const [mergePolicy, setMergePolicy] = useState("manual");
  const [mergePolicyNotice, setMergePolicyNotice] = useState("");
  const [token, setToken] = useState("");
  const [tokenInput, setTokenInput] = useState("");
  useEffect(() => { setToken(storedToken()); }, []);
  function authHeaders(): Record<string, string> {
    return token ? { authorization: `Bearer ${token}` } : {};
  }
  function forgetToken() {
    try { localStorage.removeItem(TOKEN_STORAGE_KEY); } catch { /* ignore */ }
    setToken("");
  }
  function unlock(event: FormEvent) {
    event.preventDefault();
    if (!tokenInput.trim()) return;
    try { localStorage.setItem(TOKEN_STORAGE_KEY, tokenInput.trim()); } catch { /* ignore */ }
    setToken(tokenInput.trim());
    setTokenInput("");
  }
  useEffect(() => {
    if (!token) return;
    let active = true;
    void fetch("/api/github/status", { headers: authHeaders() }).then(async (response) => {
      if (response.status === 401) { forgetToken(); return null; }
      return response.ok ? response.json() : null;
    }).then((value) => { if (active && value) setGitHub(value as { connected: boolean; method: string; installUrl: string | null }); }).catch(() => undefined);
    return () => { active = false; };
  }, [token]);
  useEffect(() => {
    if (!token) return;
    const [owner, name] = repository.split("/");
    if (!owner || !name) return;
    let active = true;
    void fetch("/api/settings/repositories", { headers: authHeaders() }).then(async (response) => {
      if (response.status === 401) { forgetToken(); return null; }
      return response.ok ? response.json() : null;
    }).then((value) => {
      if (!active || !value) return;
      const match = (value as { repositories: { owner: string; name: string; mergePolicy: string }[] }).repositories
        .find((row) => row.owner === owner.toLowerCase() && row.name === name.toLowerCase());
      setMergePolicy(match?.mergePolicy ?? "manual");
    }).catch(() => undefined);
    return () => { active = false; };
  }, [token, repository]);
  async function saveMergePolicy(nextPolicy: string) {
    const [owner, name] = repository.split("/");
    if (!owner || !name) { setMergePolicyNotice("Enter a repository as owner/name first."); return; }
    setMergePolicy(nextPolicy);
    try {
      const response = await fetch("/api/settings/repositories", {
        method: "PUT",
        headers: { "content-type": "application/json", ...authHeaders() },
        body: JSON.stringify({ owner, name, mergePolicy: nextPolicy }),
      });
      if (response.status === 401) { forgetToken(); return; }
      const result = (await response.json()) as { message?: string };
      setMergePolicyNotice(response.ok ? "" : result.message ?? "Could not save the merge policy.");
    } catch { setMergePolicyNotice("The settings service is temporarily unavailable."); }
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!objective.trim()) return;
    setSubmitting(true); setNotice("");
    try {
      const response = await fetch("/api/tasks", { method: "POST", headers: { "content-type": "application/json", ...authHeaders() }, body: JSON.stringify({ repository, branch, mode, objective }) });
      if (response.status === 401) { forgetToken(); setNotice("Your access code expired. Enter it again to continue."); return; }
      const result = (await response.json()) as { message?: string; taskId?: string };
      setNotice(response.ok ? `Task ${result.taskId ?? "queued"} was sent to GitHub Actions.` : result.message ?? "Task dispatch is not configured yet.");
      if (response.ok) setObjective("");
    } catch { setNotice("The task dispatcher is temporarily unavailable."); }
    finally { setSubmitting(false); }
  }
  if (!token) {
    return <main className="hero" id="top">
      <div className="eyebrow"><span>01</span> Autonomous engineering, under control</div>
      <h1>Enter your<br /><em>access code.</em></h1>
      <form className="command" onSubmit={unlock}>
        <label htmlFor="operator-token">Access code</label>
        <div className="objective"><span className="prompt">›</span><input id="operator-token" type="password" value={tokenInput} onChange={(event) => setTokenInput(event.target.value)} placeholder="Paste the code you were given" autoComplete="off" /><button>UNLOCK</button></div>
      </form>
    </main>;
  }
  return <main>
    <header className="topbar"><a className="brand" href="#top"><span className="brandmark">A</span>ATLAS</a><nav><a href="#mission">Mission</a><a href="#activity">Activity</a><a href="#runtime">Runtime</a></nav><span className="online"><i /> Control plane online</span></header>
    <section className="hero" id="top"><div className="eyebrow"><span>01</span> Autonomous engineering, under control</div><h1>From intent to<br /><em>verified change.</em></h1><p className="lede">Atlas understands your repository, proposes a bounded change, validates it, and commits only after policy and approval gates pass.</p>
      <form className="command" onSubmit={submit}>
        <div className="taskmeta">
          <label>Repository<input aria-label="Repository" value={repository} onChange={(event) => setRepository(event.target.value)} placeholder="owner/repository" autoComplete="off" /></label>
          <label>Branch<input aria-label="Branch" value={branch} onChange={(event) => setBranch(event.target.value)} placeholder="main" autoComplete="off" /></label>
          <label>Mode<select aria-label="Task mode" value={mode} onChange={(event) => setMode(event.target.value)}><option value="inspect">Inspect</option><option value="debug">Debug (build + test)</option><option value="coder">Coder (proposes a PR)</option></select></label>
        </div>
        <label htmlFor="objective">What should Atlas do?</label><div className="objective"><span className="prompt">›</span><input id="objective" value={objective} onChange={(event) => setObjective(event.target.value)} placeholder="Map an API, diagnose a failing test, review the architecture…" /><button disabled={submitting || github?.connected === false}>{submitting ? "QUEUING" : "START TASK"}</button></div><small>GitHub Actions runner · Coder always opens a pull request for review — it never merges itself, regardless of the merge-policy setting below</small>
      </form>{notice && <p className="notice" role="status">{notice}</p>}
      <div className={`connection ${github?.connected ? "connected" : ""}`}><span>{github === null ? "Checking GitHub connection…" : github.connected ? `GitHub connected via ${github.method}` : "GitHub is not connected"}</span>{github?.installUrl && !github.connected && <a href={github.installUrl} rel="noreferrer">Install GitHub App ↗</a>}</div>
      <div className="mergepolicy">
        <label>Merge policy for {repository}
          <select aria-label="Merge policy" value={mergePolicy} onChange={(event) => void saveMergePolicy(event.target.value)}>
            <option value="manual">Manual — a person merges every PR</option>
            <option value="ci-gated">Auto-merge when CI is green</option>
            <option value="none">Auto-merge immediately, no check (not recommended)</option>
          </select>
        </label>
        {mergePolicyNotice && <p className="notice" role="status">{mergePolicyNotice}</p>}
      </div>
    </section>
    <section className="metrics"><article><strong>149</strong><span>VALIDATION CHECKS</span></article><article><strong>05</strong><span>READ-ONLY TOOLS</span></article><article><strong>00</strong><span>UNREVIEWED COMMITS</span></article><article><strong>LOCAL</strong><span>DEFAULT MODEL ROUTE</span></article></section>
    <section className="split" id="mission"><div><div className="eyebrow"><span>02</span> Operating model</div><h2>Autonomy with<br />hard boundaries.</h2></div><div className="principles"><article><b>01</b><div><h3>Understand first</h3><p>Deterministic repository maps, symbols, references, manifests, and source evidence.</p></div></article><article><b>02</b><div><h3>Preview every mutation</h3><p>Exact diffs, scoped capabilities, expiring approvals, and optimistic concurrency.</p></div></article><article><b>03</b><div><h3>Prove the result</h3><p>Baseline-aware builds and tests distinguish new failures from existing conditions.</p></div></article></div></section>
    <section className="activity" id="activity"><div className="sectionhead"><div><div className="eyebrow"><span>03</span> Build progression</div><h2>System activity</h2></div><span className="branch">agent/initial-atlas-cli-foundation</span></div><div className="activitygrid">{activity.map((item,index)=><article key={item.title}><span className="index">0{index+1}</span><div><h3>{item.title}</h3><p>{item.detail}</p></div><mark className={item.status.toLowerCase()}>{item.status}</mark></article>)}</div></section>
    <section className="runtime" id="runtime"><div><div className="eyebrow light"><span>04</span> Inference strategy</div><h2>No token meter.<br />Your machine,<br />your limits.</h2></div><div><p>Run an open-weight coding model through a loopback-compatible server. Atlas keeps the provider contract neutral, so local inference can remain the default while hosted fallbacks stay optional.</p><ul><li>Open-weight model served locally</li><li>No per-token API charge</li><li>Repository data stays on your network</li><li>Hardware and electricity are the real cost</li></ul></div></section>
    <footer><span>ATLAS / 2026</span><span>LOCAL-FIRST · POLICY-ENFORCED · AUDITABLE</span></footer>
  </main>;
}
