"use client";
import { FormEvent, useEffect, useState } from "react";
import { AtlasMark } from "./AtlasMark.js";
import { AtlasWorkspace } from "./AtlasWorkspace.js";
import { MarketingNav } from "./MarketingNav.js";

const activity = [
  { title: "Repository intelligence foundation", detail: "149 checks passed", status: "Shipped" },
  { title: "GitHub repository host", detail: "Read-only adapter connected", status: "Ready" },
  { title: "Hosted control plane", detail: "Deployment candidate", status: "Building" },
];

const TIER_LABELS: Record<string, string> = { free: "Free", pro: "Pro", team: "Team" };
const TASK_POLL_MS = 12_000;

const STATUS_LABELS: Record<string, string> = {
  dispatched: "Dispatched",
  queued: "Queued",
  running: "Running",
  succeeded: "Succeeded",
  failed: "Failed",
  cancelled: "Cancelled",
  timed_out: "Timed out",
  skipped: "Skipped",
  action_required: "Action required",
};
// Borrowed from the .activity marks in globals.css so the palette stays one system.
const STATUS_COLORS: Record<string, string> = {
  succeeded: "#56670a",
  failed: "#8f2f21",
  timed_out: "#8f2f21",
  cancelled: "#686b63",
  skipped: "#686b63",
  action_required: "#8d5b00",
  running: "#8d5b00",
  queued: "#8d5b00",
  dispatched: "#686b63",
};

type TaskRecord = {
  taskId: string;
  conversationId?: string | null;
  repository: string;
  branch: string;
  mode: string;
  objective: string;
  mergePolicy: string;
  createdAt: string;
  status: string;
  run: { id: number; url: string | null; status: string | null; conclusion: string | null } | null;
  pullRequest: { number: number; url: string | null; state: string | null; merged: boolean } | null;
};

type TaskList = { tasks: TaskRecord[]; historyAvailable: boolean; liveStatus: boolean };
type GitHubOptions = { repositories: string[]; branches: string[]; defaultBranch: string };

function relativeTime(value: string): string {
  const parsed = Date.parse(/^\d{4}-\d{2}-\d{2} /.test(value) ? `${value.replace(" ", "T")}Z` : value);
  if (Number.isNaN(parsed)) return "";
  const seconds = Math.max(0, Math.round((Date.now() - parsed) / 1000));
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

type AccountInfo = {
  signedIn: boolean;
  userId?: string;
  githubLogin?: string | null;
  avatarUrl?: string | null;
  tier?: "free" | "pro" | "team" | null;
  status?: string;
  unrestricted?: boolean;
  usage?: { used: number; limit: number };
  modes?: string[];
};

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
  const [tokenInput, setTokenInput] = useState("");
  const [showAccessCode, setShowAccessCode] = useState(false);
  const [account, setAccount] = useState<AccountInfo | null>(null);
  const [billingNotice, setBillingNotice] = useState("");
  const [billingBusy, setBillingBusy] = useState(false);
  const [taskList, setTaskList] = useState<TaskList | null>(null);
  const [repositoryOptions, setRepositoryOptions] = useState(["cornerstonemarketingus/atlas"]);
  const [branchOptions, setBranchOptions] = useState(["main"]);
  const [defaultBranch, setDefaultBranch] = useState("main");
  const [conversationId, setConversationId] = useState<string | null>(null);

  function authHeaders(): Record<string, string> { return {}; }
  async function unlock(event: FormEvent) {
    event.preventDefault();
    if (!tokenInput.trim()) return;
    const response = await fetch("/api/auth/operator", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ accessCode: tokenInput.trim() }),
    });
    if (response.ok) {
      setTokenInput("");
      window.location.reload();
      return;
    }
    const result = await response.json().catch(() => ({})) as { message?: string };
    setNotice(result.message ?? "That access code could not be verified.");
  }
  async function signOut() {
    try { await fetch("/api/auth/logout", { method: "POST" }); } catch { /* ignore */ }
    setAccount(null);
  }
  useEffect(() => {
    let active = true;
    void fetch("/api/account", { headers: authHeaders() })
      .then((response) => (response.ok ? response.json() : { signedIn: false }))
      .catch(() => ({ signedIn: false }))
      .then((value) => { if (active) setAccount(value as AccountInfo); });
    return () => { active = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const signedIn = account?.signedIn === true;
  useEffect(() => {
    if (!signedIn) return;
    let active = true;
    void fetch("/api/github/status", { headers: authHeaders() }).then(async (response) => {
      if (response.status === 401) return null;
      return response.ok ? response.json() : null;
    }).then((value) => { if (active && value) setGitHub(value as { connected: boolean; method: string; installUrl: string | null }); }).catch(() => undefined);
    return () => { active = false; };
  }, [signedIn]);
  useEffect(() => {
    if (!signedIn) return;
    let active = true;
    void fetch(`/api/github/options?repository=${encodeURIComponent(repository)}`, { headers: authHeaders() })
      .then((response) => (response.ok ? response.json() : null))
      .then((value) => {
        if (!active || !value) return;
        const options = value as GitHubOptions;
        if (options.repositories.length) setRepositoryOptions(options.repositories);
        if (options.branches.length) setBranchOptions(options.branches);
        setDefaultBranch(options.defaultBranch);
        if (!options.branches.includes(branch)) setBranch(options.defaultBranch);
      })
      .catch(() => undefined);
    return () => { active = false; };
  }, [signedIn, repository]);
  useEffect(() => {
    if (!signedIn) return;
    const [owner, name] = repository.split("/");
    if (!owner || !name) return;
    let active = true;
    void fetch("/api/settings/repositories", { headers: authHeaders() }).then(async (response) => {
      if (response.status === 401) return null;
      return response.ok ? response.json() : null;
    }).then((value) => {
      if (!active || !value) return;
      const match = (value as { repositories: { owner: string; name: string; mergePolicy: string }[] }).repositories
        .find((row) => row.owner === owner.toLowerCase() && row.name === name.toLowerCase());
      setMergePolicy(match?.mergePolicy ?? "manual");
    }).catch(() => undefined);
    return () => { active = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signedIn, repository]);
  function refreshTasks() {
    return fetch("/api/tasks", { headers: authHeaders() })
      .then((response) => (response.ok ? response.json() : null))
      .then((value) => { if (value) setTaskList(value as TaskList); })
      .catch(() => undefined);
  }
  // Status is pulled from GitHub rather than pushed by the runner (see
  // app/api/tasks/github-runs.mjs), so the list is only as fresh as this poll.
  useEffect(() => {
    if (!signedIn) return;
    void refreshTasks();
    const timer = setInterval(() => { void refreshTasks(); }, TASK_POLL_MS);
    return () => clearInterval(timer);
  }, [signedIn]);
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
      const result = (await response.json()) as { message?: string };
      setMergePolicyNotice(response.ok ? "" : result.message ?? "Could not save the merge policy.");
    } catch { setMergePolicyNotice("The settings service is temporarily unavailable."); }
  }
  async function startCheckout(tier: "pro" | "team") {
    setBillingBusy(true); setBillingNotice("");
    try {
      const response = await fetch("/api/billing/checkout", {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeaders() },
        body: JSON.stringify({ tier }),
      });
      const result = (await response.json()) as { url?: string; message?: string };
      if (response.ok && result.url) { window.location.href = result.url; return; }
      setBillingNotice(result.message ?? "Could not start checkout.");
    } catch { setBillingNotice("The billing service is temporarily unavailable."); }
    finally { setBillingBusy(false); }
  }
  async function openBillingPortal() {
    setBillingBusy(true); setBillingNotice("");
    try {
      const response = await fetch("/api/billing/portal", { method: "POST", headers: authHeaders() });
      const result = (await response.json()) as { url?: string; message?: string };
      if (response.ok && result.url) { window.location.href = result.url; return; }
      setBillingNotice(result.message ?? "Could not open the billing portal.");
    } catch { setBillingNotice("The billing service is temporarily unavailable."); }
    finally { setBillingBusy(false); }
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!objective.trim()) return;
    setSubmitting(true); setNotice("");
    try {
      const response = await fetch("/api/tasks", { method: "POST", headers: { "content-type": "application/json", ...authHeaders() }, body: JSON.stringify({ repository, branch, mode, objective, conversationId }) });
      const result = (await response.json()) as { message?: string; taskId?: string; conversationId?: string };
      setNotice(response.ok ? `Task ${result.taskId ?? "queued"} was sent to GitHub Actions.` : result.message ?? "Task dispatch is not configured yet.");
      if (response.ok) { setConversationId(result.conversationId ?? conversationId); setObjective(""); void refreshAccount(); void refreshTasks(); }
    } catch { setNotice("The task dispatcher is temporarily unavailable."); }
    finally { setSubmitting(false); }
  }
  function refreshAccount() {
    return fetch("/api/account", { headers: authHeaders() })
      .then((response) => (response.ok ? response.json() : null))
      .then((value) => { if (value) setAccount(value as AccountInfo); })
      .catch(() => undefined);
  }

  // Renders the sign-in gate both before the account check resolves and
  // after it confirms the visitor isn't signed in — useEffect never runs
  // during server rendering, so treating "not yet known" as "not signed in"
  // is what keeps the server-rendered HTML meaningful instead of a blank
  // loading stub.
  if (!signedIn) {
    return <main id="top"><MarketingNav /><div className="signin-shell"><section className="signin-story">
      <div className="workspace-brand"><span><AtlasMark /></span>ATLAS</div>
      <div><p className="signin-kicker">AUTONOMOUS VIBE CODING, UNDER CONTROL</p><h1>Describe the product.<br />Atlas builds the business.</h1><p>Go from idea to working software with an engineering agent that can code, test, deploy, and operate the browser workflows around your product.</p><p className="signin-demo-link"><a href="/demo">See a product mission in action →</a></p></div>
      <div className="signin-proof"><span>Prompt to working product</span><span>Code and computer operation</span><span>Local-first ownership</span></div>
    </section><section className="signin-access"><div>
      <p className="signin-kicker">START FREE</p><h2>Your product team in one workspace.</h2><p>Connect GitHub to build and improve real software, or use an owner access code for your private Atlas deployment.</p>
      <div className="signin-actions">
        <a
          href="/api/auth/github/start"
          className="signin-primary"
        >
          Continue securely <span>→</span>
        </a>
        {!showAccessCode && (
          <button type="button" onClick={() => setShowAccessCode(true)} className="signin-secondary">
            Use an owner access code
          </button>
        )}
        {showAccessCode && (
          <form onSubmit={(event) => void unlock(event)} className="access-code-form">
            <label htmlFor="operator-token">Owner access code</label>
            <div><input id="operator-token" type="password" value={tokenInput} onChange={(event) => setTokenInput(event.target.value)} placeholder="Paste your private code" autoComplete="off" /><button>Unlock</button></div>
          </form>
        )}
        {notice && <p className="notice" role="status">{notice}</p>}
      </div><small>By continuing, you agree to the <a href="/legal/terms">Terms</a> and <a href="/legal/privacy">Privacy Policy</a>. <a href="/pricing">View pricing</a>.</small></div></section></div></main>;
  }
  if (process.env.NEXT_PUBLIC_ATLAS_WORKSPACE !== "legacy") {
    return <AtlasWorkspace
      repository={repository} repositories={repositoryOptions} branch={branch} branches={branchOptions} defaultBranch={defaultBranch}
      mode={mode} objective={objective} submitting={submitting} notice={notice} tasks={taskList?.tasks ?? []}
      accountLabel={account?.githubLogin ?? "Owner"} connected={github?.connected ?? null}
      conversationId={conversationId} onConversation={setConversationId}
      onRepository={setRepository} onBranch={setBranch} onMode={setMode} onObjective={setObjective}
      onSubmit={submit} onSignOut={() => void signOut()}
    />;
  }
  return <main>
    <header className="topbar">
      <a className="brand" href="#top"><span className="brandmark"><AtlasMark /></span>ATLAS</a>
      <nav><a href="/computer">Computer</a><a href="/setup">Setup</a><a href="#mission">Mission</a><a href="#activity">Activity</a></nav>
      <div className="flex items-center gap-4">
        {account?.githubLogin && (
          // An avatar rather than the login text: the account still has to be
          // identifiable, but a GitHub org name set in the header reads as part
          // of the product's name, which it is not.
          // next/image wants remotePatterns config and an optimizer the
          // Worker runtime does not provide, for a 28px avatar served
          // straight from GitHub.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={`https://github.com/${encodeURIComponent(account.githubLogin)}.png?size=64`}
            alt={`Signed in as ${account.githubLogin}`}
            title={account.githubLogin}
            width={28}
            height={28}
            className="rounded-full border border-[var(--line)]"
          />
        )}
        <span className="online"><i /> Control plane online</span>
        <button type="button" onClick={() => void signOut()} className="text-xs uppercase tracking-wide underline underline-offset-4">Sign out</button>
      </div>
    </header>
    <section className="hero" id="top"><div className="eyebrow"><span>01</span> Autonomous engineering, under control</div><h1>From intent to<br /><em>verified change.</em></h1><p className="lede">Atlas understands your repository, proposes a bounded change, validates it, and commits only after policy and approval gates pass.</p>
      <form className="command" onSubmit={submit}>
        <div className="taskmeta">
          <label>Repository<select aria-label="Repository" value={repository} onChange={(event) => setRepository(event.target.value)}>
            {repositoryOptions.map((name) => <option key={name} value={name}>{name}</option>)}
          </select></label>
          <label>Branch<select aria-label="Branch" value={branch} onChange={(event) => setBranch(event.target.value)}>
            {branchOptions.map((name) => <option key={name} value={name}>{name}{name === defaultBranch ? " (default)" : ""}</option>)}
          </select></label>
          <label>Mode<select aria-label="Task mode" value={mode} onChange={(event) => setMode(event.target.value)}>
            <option value="inspect">Inspect</option>
            <option value="debug">Debug (build + test)</option>
            <option value="coder" disabled={account?.modes ? !account.modes.includes("coder") : false}>
              Coder (proposes a PR){account?.modes && !account.modes.includes("coder") ? " — upgrade to unlock" : ""}
            </option>
          </select></label>
        </div>
        <label htmlFor="objective">What should Atlas do?</label><div className="objective"><span className="prompt">›</span><input id="objective" value={objective} onChange={(event) => setObjective(event.target.value)} placeholder="Map an API, diagnose a failing test, review the architecture…" /><button disabled={submitting || github?.connected === false}>{submitting ? "QUEUING" : "START TASK"}</button></div><small>GitHub Actions runner · Coder always opens a pull request for review — whether it goes on to merge that PR itself depends on the merge-policy setting below</small>
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
      {!account?.unrestricted && (
        <div className="mt-8 max-w-[880px] border border-[var(--line)] p-5 flex flex-wrap items-center justify-between gap-4">
          <div>
            <div className="font-mono text-xs uppercase tracking-wide text-[var(--muted)]">Plan</div>
            <div className="text-xl font-bold">{TIER_LABELS[account?.tier ?? "free"] ?? "Free"}{account?.status === "past_due" ? " — payment past due" : ""}</div>
            {account?.usage && <div className="text-sm text-[var(--muted)] mt-1">{account.usage.used} / {account.usage.limit} tasks used this month</div>}
          </div>
          <div className="flex gap-3 flex-wrap">
            {account?.tier !== "team" && (
              <button type="button" disabled={billingBusy} onClick={() => void startCheckout(account?.tier === "pro" ? "team" : "pro")} className="bg-[var(--ink)] text-white font-bold text-xs uppercase tracking-wide py-3 px-4">
                {account?.tier === "pro" ? "Upgrade to Team" : "Upgrade to Pro"}
              </button>
            )}
            {(account?.tier === "pro" || account?.tier === "team") && (
              <button type="button" disabled={billingBusy} onClick={() => void openBillingPortal()} className="border border-[var(--ink)] font-bold text-xs uppercase tracking-wide py-3 px-4">
                Manage billing
              </button>
            )}
          </div>
          {billingNotice && <p className="notice basis-full">{billingNotice}</p>}
        </div>
      )}
      <div className="mt-10 max-w-[880px]">
        <div className="flex items-baseline justify-between gap-4 border-b border-[var(--line)] pb-3">
          <h2 className="m-0 text-lg font-bold tracking-tight">Recent tasks</h2>
          <span className="font-mono text-[10px] uppercase tracking-[.09em] text-[var(--muted)]">
            {taskList && !taskList.liveStatus ? "GitHub status unavailable" : "Live from GitHub Actions"}
          </span>
        </div>
        {taskList === null && <p className="notice">Checking your tasks…</p>}
        {taskList !== null && !taskList.historyAvailable && (
          <p className="notice">Task history is unavailable — tasks still dispatch, but nothing is being recorded. Run the D1 migration to turn it on.</p>
        )}
        {taskList !== null && taskList.historyAvailable && taskList.tasks.length === 0 && (
          <p className="notice">No tasks yet. Start one above and it will show up here with its run status.</p>
        )}
        <ul className="m-0 list-none p-0">
          {(taskList?.tasks ?? []).map((item) => (
            <li key={item.taskId} className="flex flex-col gap-2 border-b border-[var(--line)] py-4">
              <div className="flex flex-wrap items-center gap-3">
                <span className="border border-[var(--line)] px-2 py-1 font-mono text-[10px] font-bold uppercase tracking-[.09em]">{item.mode}</span>
                <span className="border px-2 py-1 font-mono text-[10px] font-bold uppercase tracking-[.09em]" style={{ color: STATUS_COLORS[item.status] ?? "var(--muted)", borderColor: "currentColor" }}>
                  {STATUS_LABELS[item.status] ?? item.status}
                </span>
                <span className="ml-auto font-mono text-[10px] uppercase tracking-[.09em] text-[var(--muted)]">{relativeTime(item.createdAt)}</span>
              </div>
              <p className="m-0 text-base leading-snug">{item.objective}</p>
              <div className="flex flex-wrap items-center gap-4 font-mono text-[11px] text-[var(--muted)]">
                <span>{item.repository} · {item.branch}</span>
                {item.run?.url && <a href={item.run.url} target="_blank" rel="noreferrer" className="text-[var(--ink)] underline underline-offset-4">Actions run ↗</a>}
                {item.pullRequest?.url && (
                  <a href={item.pullRequest.url} target="_blank" rel="noreferrer" className="text-[var(--ink)] underline underline-offset-4">
                    {item.pullRequest.merged ? `Pull request #${item.pullRequest.number} · merged` : `Pull request #${item.pullRequest.number}`} ↗
                  </a>
                )}
              </div>
            </li>
          ))}
        </ul>
      </div>
    </section>
    <section className="metrics"><article><strong>149</strong><span>VALIDATION CHECKS</span></article><article><strong>05</strong><span>READ-ONLY TOOLS</span></article><article><strong>00</strong><span>UNREVIEWED COMMITS</span></article><article><strong>LOCAL</strong><span>DEFAULT MODEL ROUTE</span></article></section>
    <section className="split" id="mission"><div><div className="eyebrow"><span>02</span> Operating model</div><h2>Autonomy with<br />hard boundaries.</h2></div><div className="principles"><article><b>01</b><div><h3>Understand first</h3><p>Deterministic repository maps, symbols, references, manifests, and source evidence.</p></div></article><article><b>02</b><div><h3>Preview every mutation</h3><p>Exact diffs, scoped capabilities, expiring approvals, and optimistic concurrency.</p></div></article><article><b>03</b><div><h3>Prove the result</h3><p>Baseline-aware builds and tests distinguish new failures from existing conditions.</p></div></article></div></section>
    <section className="activity" id="activity"><div className="sectionhead"><div><div className="eyebrow"><span>03</span> Build progression</div><h2>System activity</h2></div><span className="branch">agent/initial-atlas-cli-foundation</span></div><div className="activitygrid">{activity.map((item,index)=><article key={item.title}><span className="index">0{index+1}</span><div><h3>{item.title}</h3><p>{item.detail}</p></div><mark className={item.status.toLowerCase()}>{item.status}</mark></article>)}</div></section>
    <section className="runtime" id="runtime"><div><div className="eyebrow light"><span>04</span> Inference strategy</div><h2>No token meter.<br />Your machine,<br />your limits.</h2></div><div><p>Run an open-weight coding model through a loopback-compatible server. Atlas keeps the provider contract neutral, so local inference can remain the default while hosted fallbacks stay optional.</p><ul><li>Open-weight model served locally</li><li>No per-token API charge</li><li>Repository data stays on your network</li><li>Hardware and electricity are the real cost</li></ul></div></section>
    <footer><span>ATLAS / 2026</span><span><a href="/legal/privacy">Privacy</a> · <a href="/legal/terms">Terms</a> · <a href="/account">Account</a></span></footer>
  </main>;
}
