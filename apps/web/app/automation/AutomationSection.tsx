"use client";
import Link from "next/link";
import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { AtlasShell } from "../AtlasShell.js";

type Workflow = "custom" | "job-application" | "sales-outreach" | "marketing";
type Device = { id: string; name: string; status: string; lastSeenAt: string | null; revokedAt: string | null };
type TaskEvent = { id: string; kind: string; summary: string; detail: string | null; createdAt: string };
type Task = { id: string; workflowType: Workflow; objective: string; status: string; result: string | null; error: string | null; createdAt: string; events: TaskEvent[] };
type Approval = { id: string; summary: string; domain: string | null; expiresAt: string };
type Capabilities = { providers: { windows: { available: boolean }; cloudflare: { available: boolean; entitled: boolean; configured: boolean; monthlyMinutes: number | null } } };

const WORKFLOWS: Array<{ id: Workflow; eyebrow: string; title: string; summary: string; startUrl: string; objective: string; guardrail: string }> = [
  { id: "job-application", eyebrow: "CAREER", title: "Apply for roles", summary: "Find strong-fit roles, prepare tailored answers, and complete forms.", startUrl: "https://www.linkedin.com/jobs/", objective: "Find roles matching my profile and preferences. For each strong match, summarize why it fits, prepare accurate tailored application answers, fill the form, and pause before every final submission.", guardrail: "You approve every application" },
  { id: "sales-outreach", eyebrow: "SALES", title: "Build qualified pipeline", summary: "Research prospects and prepare personal, evidence-based outreach.", startUrl: "https://www.linkedin.com/", objective: "Research qualified prospects for my offer, capture the source for each personalization detail, draft one-to-one outreach, and pause before sending or enrolling anyone in a sequence. Do not send bulk unsolicited messages.", guardrail: "You approve every send" },
  { id: "marketing", eyebrow: "GROWTH", title: "Operate campaigns", summary: "Draft posts, update listings, and prepare campaign changes across the web.", startUrl: "", objective: "Prepare the requested marketing work, verify claims against the provided source material, and pause before publishing, launching a campaign, or changing any spend.", guardrail: "You approve publish and spend" },
  { id: "custom", eyebrow: "GENERAL", title: "Run a browser task", summary: "Research, enter data, manage portals, and complete repeatable browser work.", startUrl: "", objective: "", guardrail: "Sensitive actions always pause" },
];

/** Tasks: supervised browser work on a paired computer or an entitled hosted browser. */
export function AutomationSection() {
  const [devices, setDevices] = useState<Device[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [capabilities, setCapabilities] = useState<Capabilities | null>(null);
  const [credential, setCredential] = useState("");
  const [copied, setCopied] = useState(false);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [provider, setProvider] = useState<"windows" | "cloudflare">("windows");
  const [deviceId, setDeviceId] = useState("");
  const [workflow, setWorkflow] = useState<Workflow>("job-application");
  const [objective, setObjective] = useState(WORKFLOWS[0].objective);
  const [startUrl, setStartUrl] = useState(WORKFLOWS[0].startUrl);
  const [tab, setTab] = useState<"attention" | "running" | "history">("attention");
  const taskComposerRef = useRef<HTMLElement>(null);

  const refresh = useCallback(async () => {
    const [deviceResponse, taskResponse] = await Promise.all([
      fetch("/api/computer/devices", { cache: "no-store" }),
      fetch("/api/computer/tasks", { cache: "no-store" }),
    ]);
    if (deviceResponse.status === 401 || taskResponse.status === 401) { window.location.href = "/"; return; }
    if (!deviceResponse.ok || !taskResponse.ok) throw new Error("Automation is temporarily unavailable. Check that the database migration in Connections has been applied.");
    setDevices((await deviceResponse.json()).devices);
    const data = await taskResponse.json();
    setTasks(data.tasks); setApprovals(data.approvals); setCapabilities(data.capabilities);
  }, []);

  useEffect(() => {
    const first = window.setTimeout(() => void refresh().catch((error: Error) => setNotice(error.message)), 0);
    const timer = window.setInterval(() => void refresh().catch(() => undefined), 5000);
    return () => { window.clearTimeout(first); window.clearInterval(timer); };
  }, [refresh]);

  function choose(next: Workflow) {
    const selected = WORKFLOWS.find((item) => item.id === next)!;
    setWorkflow(next); setObjective(selected.objective); setStartUrl(selected.startUrl);
  }

  async function pair(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setCopied(false);
    const form = new FormData(event.currentTarget);
    const response = await fetch("/api/computer/devices", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: form.get("name") }) });
    const data = await response.json(); setBusy(false);
    if (!response.ok) { setNotice(data.message); return; }
    setCredential(data.credential);
    setNotice("Pairing created. Download the pairing file and open it during companion setup. It is shown only once.");
    await refresh().catch(() => undefined);
  }

  function downloadPairing() {
    if (!credential) return;
    const file = new Blob([JSON.stringify({ version: 1, endpoint: window.location.origin, credential })], { type: "application/vnd.atlas.pairing+json" });
    const url = URL.createObjectURL(file);
    const link = document.createElement("a"); link.href = url; link.download = "atlas-pairing.atlas-pair"; link.click();
    URL.revokeObjectURL(url);
    setNotice("Pairing file downloaded. Import it during companion setup; the installer encrypts the credential and deletes the handoff file.");
  }

  async function queue(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true);
    const response = await fetch("/api/computer/tasks", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ deviceId, executionProvider: provider, workflowType: workflow, objective, startUrl }),
    });
    const data = await response.json(); setBusy(false);
    if (!response.ok) { setNotice(data.message); return; }
    setNotice("Queued. Atlas will pause before any consequential action.");
    await refresh().catch(() => undefined);
  }

  async function decide(id: string, decision: "approved" | "rejected") {
    await fetch(`/api/computer/approvals/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ decision }) });
    await refresh().catch(() => undefined);
  }
  async function cancel(id: string) {
    await fetch(`/api/computer/tasks/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "cancel" }) });
    await refresh().catch(() => undefined);
  }
  async function revoke(id: string) {
    await fetch(`/api/computer/devices/${id}`, { method: "DELETE" });
    await refresh().catch(() => undefined);
  }

  const active = WORKFLOWS.find((item) => item.id === workflow)!;
  const available = devices.filter((device) => !device.revokedAt);
  const online = available.some((device) => device.status === "online");
  const hostedReady = capabilities?.providers.cloudflare.available === true;
  // Stated rather than implied: a disabled button with no reason beside it is
  // the single most common way this interface looked broken.
  const blocker = provider === "windows"
    ? (available.length === 0 ? "Pair a computer below before Atlas can run a browser task."
      : !deviceId ? "Choose which paired computer should run this."
        : "")
    : (!capabilities?.providers.cloudflare.entitled ? "A hosted browser needs a Pro or Team plan."
      : !capabilities?.providers.cloudflare.configured ? "Hosted browsing is included with your plan but is not active on this deployment yet."
        : "");
  const runningTasks = tasks.filter((item) => ["queued", "running"].includes(item.status));
  const historyTasks = tasks.filter((item) => !["queued", "running"].includes(item.status));
  const attention = approvals.length > 0;
  const visibleTasks = tab === "running" ? runningTasks : tab === "history" ? historyTasks : tasks.filter((item) => item.status === "paused" || item.status === "awaiting_approval");
  function startTask() {
    taskComposerRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    window.setTimeout(() => document.querySelector<HTMLTextAreaElement>("[aria-label='What should Atlas accomplish?']")?.focus(), 250);
  }

  return <AtlasShell
    section="automation"
    headerContext={<span className={`context-chip ${online ? "live" : ""}`}>{online ? "Computer ready" : available.length ? "Computer offline" : "No computer paired"}</span>}
  >
    <div className="section-scroll">
      <div className="section-page">
        <header className="page-head">
          <p className="kicker">TASKS</p>
          <h1>See what Atlas is working on.</h1>
          <p>Review active work, respond when Atlas needs you, and open the evidence when a task is complete.</p>
          <button className="page-action task-primary" type="button" onClick={startTask}>＋ New task</button>
        </header>

        {notice && <p className="page-notice" role="status">{notice}</p>}

        {approvals.length > 0 && <section className="approval-panel">
          <p className="kicker">NEEDS YOUR ATTENTION</p>
          {approvals.map((approval) => <article key={approval.id}>
            <div><strong>{approval.summary}</strong><small>{approval.domain ?? "Browser task"} · expires {new Date(approval.expiresAt).toLocaleTimeString()}</small><p>Atlas is ready for the next action and will continue only after you approve it.</p></div>
            <div><button className="quiet" onClick={() => void decide(approval.id, "rejected")}>Reject</button><button onClick={() => void decide(approval.id, "approved")}>Review and approve</button></div>
          </article>)}
        </section>}

        <nav className="task-tabs" aria-label="Task views">
          <button className={tab === "attention" ? "active" : ""} onClick={() => setTab("attention")}>Needs your attention{attention ? ` · ${approvals.length}` : ""}</button>
          <button className={tab === "running" ? "active" : ""} onClick={() => setTab("running")}>Running{runningTasks.length ? ` · ${runningTasks.length}` : ""}</button>
          <button className={tab === "history" ? "active" : ""} onClick={() => setTab("history")}>History</button>
        </nav>

        <section className="task-inbox">
          {visibleTasks.length === 0
            ? <div className="task-empty"><strong>{tab === "attention" ? "Nothing needs you right now." : tab === "running" ? "Atlas is not running any tasks." : "No completed tasks yet."}</strong><p>{tab === "attention" ? "Atlas will show approvals here when a consequential action is ready." : "Start a task when you have something you want Atlas to handle."}</p></div>
            : visibleTasks.map((task) => <article className="task-card" key={task.id}>
              <div className={`run-state ${task.status}`}>{task.status === "completed" ? "Completed" : task.status}</div>
              <div className="task-card-main"><small>{WORKFLOWS.find((item) => item.id === task.workflowType)?.title ?? "Browser task"}</small><h2>{task.objective}</h2>{(task.result || task.error) && <p>{task.result ?? task.error}</p>}<button className="task-detail" type="button" onClick={() => document.getElementById(`task-${task.id}`)?.scrollIntoView({ behavior: "smooth" })}>View task</button></div>
              <time>{new Date(task.createdAt).toLocaleString()}</time>
            </article>)}
        </section>

        <section className="page-block task-composer" ref={taskComposerRef}>
          <h2>New task</h2>
          <p className="block-hint">Describe the result you want. Atlas will use the selected workflow and pause before consequential actions.</p>
          <div className="workflow-grid">
            {WORKFLOWS.map((item) => <button key={item.id} className={workflow === item.id ? "active" : ""} onClick={() => choose(item.id)}>
              <small>{item.eyebrow}</small><strong>{item.title}</strong><span>{item.summary}</span><em>{item.guardrail}</em>
            </button>)}
          </div>
        </section>

        <section className="page-block">
          <h2>Task details</h2>
          <form className="mission-form" onSubmit={queue}>
            <div className="field-row">
              <label>Runs on
                <select aria-label="Browser execution provider" value={provider} onChange={(event) => setProvider(event.target.value as "windows" | "cloudflare")}>
                  <option value="windows">My Windows PC · included</option>
                  <option value="cloudflare" disabled={!hostedReady}>Hosted browser{!capabilities?.providers.cloudflare.entitled ? " · Pro required" : !capabilities?.providers.cloudflare.configured ? " · activating soon" : ` · ${capabilities.providers.cloudflare.monthlyMinutes ?? "metered"} min/mo`}</option>
                </select>
              </label>
              {provider === "windows" && <label>Computer
                <select aria-label="Computer" value={deviceId} onChange={(event) => setDeviceId(event.target.value)}>
                  <option value="">{available.length ? "Choose a paired PC" : "No computer paired yet"}</option>
                  {available.map((device) => <option key={device.id} value={device.id}>{device.name} · {device.status}</option>)}
                </select>
              </label>}
            </div>
            <label>Start here <span>optional</span>
              <input value={startUrl} onChange={(event) => setStartUrl(event.target.value)} type="url" placeholder="https://…" />
            </label>
            <label>What should Atlas accomplish?
              <textarea value={objective} onChange={(event) => setObjective(event.target.value)} rows={7} maxLength={2000} required />
            </label>
            <div className="mission-footer">
              <p><b>Approval policy</b><br />{active.guardrail}. Atlas also pauses for purchases, sensitive uploads, and account or security changes.</p>
              <div className="mission-send">
                {blocker && <small className="blocker" role="status">{blocker}</small>}
                <button disabled={busy || blocker !== "" || !objective.trim()}>{busy ? "Starting…" : "Start task"}</button>
              </div>
            </div>
          </form>
        </section>

        <section className="page-block">
          <h2>Computer access</h2>
          <div className="pair-grid">
            <article className="pair-card">
              <p>Name this PC, download its pairing file, and open that file during companion setup. No credential typing required. Atlas stores only its fingerprint.</p>
              <form onSubmit={pair}>
                <label>Computer name<input name="name" defaultValue="My Windows PC" maxLength={80} required /></label>
                <button disabled={busy}>Create pairing</button>
              </form>
              {credential && <div className="credential">
                <small>Shown once · delete after import</small><code>{credential}</code>
                <div className="credential-actions"><button className="primary" onClick={downloadPairing}>Download pairing file</button><button onClick={() => { void navigator.clipboard.writeText(credential).then(() => setCopied(true)).catch(() => setCopied(false)); }}>{copied ? "Copied" : "Copy fallback"}</button></div>
              </div>}
              <ul className="device-list">
                {available.map((device) => <li key={device.id}>
                  <span>{device.name}<small>{device.status}</small></span>
                  <button onClick={() => void revoke(device.id)}>Revoke</button>
                </li>)}
                {available.length === 0 && <li className="empty">No computers paired yet.</li>}
              </ul>
            </article>
            <article className="pair-card muted">
              <h3>Your session stays yours.</h3>
              <p>The Windows companion uses a separate browser profile on your PC. Atlas receives only the task state and approval requests needed to coordinate the work.</p>
              <ol>
                <li>Download one pairing file—no credential typing.</li>
                <li>Send work from desktop or phone.</li>
                <li>Approve consequential actions here.</li>
                <li>Review the result and its receipt.</li>
              </ol>
              <p className="pair-help">Need the companion? <Link href="/setup">Connections</Link> lists every step and its status.</p>
            </article>
          </div>
        </section>

        <section className="page-block task-history-detail">
          <h2>Task details</h2>
          {tasks.length === 0 ? <p className="block-hint">No browser tasks yet.</p> : tasks.map((task) => <article className="run-row" id={`task-${task.id}`} key={task.id}>
            <span className={`run-state ${task.status}`}>{task.status}</span>
            <div>
              <small>{WORKFLOWS.find((item) => item.id === task.workflowType)?.title ?? "Browser task"}</small>
              <strong>{task.objective}</strong>
              {(task.result || task.error) && <p>{task.result ?? task.error}</p>}
              {task.events?.length > 0 && <details className="task-timeline">
                <summary>Activity receipt · {task.events.length} event{task.events.length === 1 ? "" : "s"}</summary>
                <ol>{task.events.slice().reverse().map((event) => <li key={event.id}>
                  <span className={`event-dot ${event.kind}`} />
                  <div><b>{event.summary}</b>{event.detail && <p>{event.detail}</p>}<time>{new Date(event.createdAt).toLocaleString()}</time></div>
                </li>)}</ol>
              </details>}
            </div>
            <div className="run-end">
              <time>{new Date(task.createdAt).toLocaleString()}</time>
              {["queued", "running"].includes(task.status) && <button onClick={() => void cancel(task.id)}>Cancel</button>}
            </div>
          </article>)}
        </section>
      </div>
    </div>
  </AtlasShell>;
}
