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
type HostedAutomation = {
  id: string;
  name: string;
  repository: string;
  branch: string;
  mode: string;
  objective: string;
  triggerType: string;
  trigger: { cron?: string; branch?: string; checkName?: string } | null;
  budgetLimit: number;
  budgetWindowDays: number;
  paused: boolean;
  runs: Array<{ id: string; status: string; reason: string | null; taskId: string | null; triggeredAt: string }>;
};

const WORKFLOWS: Array<{ id: Workflow; title: string; summary: string; startUrl: string; objective: string; guardrail: string }> = [
  { id: "job-application", title: "Apply for jobs", summary: "Find matching jobs and fill in applications.", startUrl: "https://www.linkedin.com/jobs/", objective: "Find roles matching my profile and preferences. For each strong match, summarize why it fits, prepare accurate tailored application answers, fill the form, and pause before every final submission.", guardrail: "Asks before submitting each application" },
  { id: "sales-outreach", title: "Find leads", summary: "Research prospects and draft personal messages.", startUrl: "https://www.linkedin.com/", objective: "Research qualified prospects for my offer, capture the source for each personalization detail, draft one-to-one outreach, and pause before sending or enrolling anyone in a sequence. Do not send bulk unsolicited messages.", guardrail: "Asks before sending anything" },
  { id: "marketing", title: "Marketing", summary: "Draft posts and update listings.", startUrl: "", objective: "Prepare the requested marketing work, verify claims against the provided source material, and pause before publishing, launching a campaign, or changing any spend.", guardrail: "Asks before publishing or spending" },
  { id: "custom", title: "Something else", summary: "Any other task on your computer, in the browser or a desktop app.", startUrl: "", objective: "", guardrail: "Asks before anything important" },
];

const STATUS_LABELS: Record<string, string> = {
  queued: "Queued", running: "Running", paused: "Paused", awaiting_approval: "Waiting for you",
  completed: "Done", failed: "Failed", cancelled: "Cancelled", rejected: "Rejected", expired: "Expired",
};
const statusLabel = (status: string) => STATUS_LABELS[status] ?? status.replaceAll("_", " ");

/** The most recent step the companion reported, for the "Now:" line on a running task. */
function latestStep(task: Task) {
  // Events arrive newest first.
  const step = task.events?.find((event) => event.kind === "progress") ?? null;
  return step ? step.summary : null;
}

/** Tasks: supervised browser and desktop work on a paired computer, or an entitled hosted browser. */
export function AutomationSection() {
  const [devices, setDevices] = useState<Device[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [hostedAutomations, setHostedAutomations] = useState<HostedAutomation[]>([]);
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
  const [automationName, setAutomationName] = useState("Weekly dependency update");
  const [automationRepository, setAutomationRepository] = useState("cornerstonemarketingus/atlas");
  const [automationBranch, setAutomationBranch] = useState("main");
  const [automationMode, setAutomationMode] = useState<"inspect" | "debug" | "coder">("debug");
  const [automationObjective, setAutomationObjective] = useState("Review and update outdated dependencies, then open a pull request with test results.");
  const [automationTriggerType, setAutomationTriggerType] = useState<"cron" | "github-check-failure">("cron");
  const [automationCron, setAutomationCron] = useState("0 9 * * 1");
  const [automationCheckName, setAutomationCheckName] = useState("");
  const [automationBudgetLimit, setAutomationBudgetLimit] = useState(1);
  const [automationBudgetWindowDays, setAutomationBudgetWindowDays] = useState(7);
  const taskComposerRef = useRef<HTMLElement>(null);

  const refresh = useCallback(async () => {
    const [deviceResponse, taskResponse, automationResponse] = await Promise.all([
      fetch("/api/computer/devices", { cache: "no-store" }),
      fetch("/api/computer/tasks", { cache: "no-store" }),
      fetch("/api/automations", { cache: "no-store" }),
    ]);
    if (deviceResponse.status === 401 || taskResponse.status === 401 || automationResponse.status === 401) { window.location.href = "/"; return; }
    if (!deviceResponse.ok || !taskResponse.ok || !automationResponse.ok) throw new Error("Automation is temporarily unavailable. Check that the database migration in Connections has been applied.");
    setDevices((await deviceResponse.json()).devices);
    const data = await taskResponse.json();
    const automationData = await automationResponse.json();
    setTasks(data.tasks); setApprovals(data.approvals); setCapabilities(data.capabilities);
    setHostedAutomations(Array.isArray(automationData.automations) ? automationData.automations : []);
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
    setNotice("Pairing created. Download the file now: it is only shown once.");
    await refresh().catch(() => undefined);
  }

  function downloadPairing() {
    if (!credential) return;
    const file = new Blob([JSON.stringify({ version: 1, endpoint: window.location.origin, credential })], { type: "application/vnd.atlas.pairing+json" });
    const url = URL.createObjectURL(file);
    const link = document.createElement("a"); link.href = url; link.download = "atlas-pairing.atlas-pair"; link.click();
    URL.revokeObjectURL(url);
    setNotice("Downloaded. Open the file in the Atlas companion app on that PC.");
  }

  async function queue(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true);
    const response = await fetch("/api/computer/tasks", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ deviceId, executionProvider: provider, workflowType: workflow, objective, startUrl }),
    });
    const data = await response.json(); setBusy(false);
    if (!response.ok) { setNotice(data.message); return; }
    setNotice("Task started.");
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
  async function createAutomation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true);
    const response = await fetch("/api/automations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: automationName,
        repository: automationRepository,
        branch: automationBranch,
        mode: automationMode,
        objective: automationObjective,
        triggerType: automationTriggerType,
        trigger: automationTriggerType === "cron"
          ? { cron: automationCron }
          : { branch: "main", checkName: automationCheckName },
        budgetLimit: automationBudgetLimit,
        budgetWindowDays: automationBudgetWindowDays,
      }),
    });
    const data = await response.json(); setBusy(false);
    if (!response.ok) { setNotice(data.message ?? "Automation could not be created."); return; }
    setNotice("Automation saved.");
    await refresh().catch(() => undefined);
  }
  async function pauseAutomation(id: string, paused: boolean) {
    await fetch(`/api/automations/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ paused }),
    });
    await refresh().catch(() => undefined);
  }

  const active = WORKFLOWS.find((item) => item.id === workflow)!;
  const available = devices.filter((device) => !device.revokedAt);
  const online = available.some((device) => device.status === "online");
  const hostedReady = capabilities?.providers.cloudflare.available === true;
  // Stated rather than implied: a disabled button with no reason beside it is
  // the single most common way this interface looked broken.
  const blocker = provider === "windows"
    ? (available.length === 0 ? "Connect a computer first (below)."
      : !deviceId ? "Choose a computer."
        : "")
    : (!capabilities?.providers.cloudflare.entitled ? "The hosted browser needs a Pro or Team plan."
      : !capabilities?.providers.cloudflare.configured ? "The hosted browser isn't available yet."
        : "");
  const runningTasks = tasks.filter((item) => ["queued", "running"].includes(item.status));
  const historyTasks = tasks.filter((item) => !["queued", "running"].includes(item.status));
  const attention = approvals.length > 0;
  const visibleTasks = tab === "running" ? runningTasks : tab === "history" ? historyTasks : tasks.filter((item) => item.status === "paused" || item.status === "awaiting_approval");
  function startTask() {
    taskComposerRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    window.setTimeout(() => document.querySelector<HTMLTextAreaElement>("[aria-label='What should Atlas do?']")?.focus(), 250);
  }

  return <AtlasShell
    section="automation"
    headerContext={<span className={`context-chip ${online ? "live" : ""}`}>{online ? "Computer online" : available.length ? "Computer offline" : "No computer connected"}</span>}
  >
    <div className="section-scroll">
      <div className="section-page">
        <header className="page-head">
          <h1>Tasks</h1>
          <p>Work Atlas does for you on your computer, in the browser or in desktop apps.</p>
          <button className="page-action task-primary" type="button" onClick={startTask}>＋ New task</button>
        </header>

        {notice && <p className="page-notice" role="status">{notice}</p>}

        <section className="page-block">
          <h2>Hosted automations</h2>
          <p>Run Atlas automatically on a schedule or when CI fails on main. Automation runs always use your repository merge policy.</p>
          <form className="mission-form" onSubmit={createAutomation}>
            <label>Name
              <input value={automationName} onChange={(event) => setAutomationName(event.target.value)} maxLength={100} required />
            </label>
            <div className="field-row">
              <label>Repository
                <input value={automationRepository} onChange={(event) => setAutomationRepository(event.target.value)} placeholder="owner/repo" required />
              </label>
              <label>Branch
                <input value={automationBranch} onChange={(event) => setAutomationBranch(event.target.value)} required />
              </label>
              <label>Mode
                <select value={automationMode} onChange={(event) => setAutomationMode(event.target.value as "inspect" | "debug" | "coder")}>
                  <option value="inspect">Inspect</option>
                  <option value="debug">Debug</option>
                  <option value="coder">Coder</option>
                </select>
              </label>
            </div>
            <label>Objective
              <textarea value={automationObjective} onChange={(event) => setAutomationObjective(event.target.value)} rows={4} maxLength={4000} required />
            </label>
            <div className="field-row">
              <label>Trigger
                <select value={automationTriggerType} onChange={(event) => setAutomationTriggerType(event.target.value as "cron" | "github-check-failure")}>
                  <option value="cron">Schedule (cron)</option>
                  <option value="github-check-failure">CI failed on main</option>
                </select>
              </label>
              {automationTriggerType === "cron"
                ? <label>Cron (UTC)
                  <input value={automationCron} onChange={(event) => setAutomationCron(event.target.value)} placeholder="0 9 * * 1" required />
                </label>
                : <label>Check name <span>optional</span>
                  <input value={automationCheckName} onChange={(event) => setAutomationCheckName(event.target.value)} placeholder="CI" />
                </label>}
              <label>Budget runs
                <input type="number" min={1} max={1000} value={automationBudgetLimit} onChange={(event) => setAutomationBudgetLimit(Number(event.target.value) || 1)} required />
              </label>
              <label>Per days
                <input type="number" min={1} max={365} value={automationBudgetWindowDays} onChange={(event) => setAutomationBudgetWindowDays(Number(event.target.value) || 7)} required />
              </label>
            </div>
            <div className="mission-send">
              <button disabled={busy}>{busy ? "Saving…" : "Create automation"}</button>
            </div>
          </form>
          <div className="task-history-detail">
            {hostedAutomations.length === 0
              ? <p>No automations yet.</p>
              : hostedAutomations.map((automation) => <article className="run-row" key={automation.id}>
                <span className={`run-state ${automation.paused ? "paused" : "running"}`}>{automation.paused ? "Paused" : "Active"}</span>
                <div>
                  <small>{automation.repository} · {automation.branch} · {automation.mode}</small>
                  <strong>{automation.name}</strong>
                  <p>{automation.objective}</p>
                  <p>Trigger: {automation.triggerType === "cron" ? automation.trigger?.cron : `CI failed on ${automation.trigger?.branch ?? "main"}`}</p>
                  <p>Budget: {automation.budgetLimit} run(s) / {automation.budgetWindowDays} day(s)</p>
                  {automation.runs.length > 0 && <details className="task-timeline">
                    <summary>Run history ({automation.runs.length})</summary>
                    <ol>{automation.runs.map((run) => <li key={run.id}>
                      <span className={`event-dot ${run.status === "started" ? "progress" : "error"}`} />
                      <div><b>{run.status.replaceAll("_", " ")}</b>{run.taskId && <p>Task: {run.taskId}</p>}{run.reason && <p>{run.reason}</p>}<time>{new Date(run.triggeredAt).toLocaleString()}</time></div>
                    </li>)}</ol>
                  </details>}
                </div>
                <div className="run-end">
                  <button onClick={() => void pauseAutomation(automation.id, !automation.paused)}>{automation.paused ? "Resume" : "Pause"}</button>
                </div>
              </article>)}
          </div>
        </section>

        {approvals.length > 0 && <section className="approval-panel">
          <p className="kicker">WAITING FOR YOU</p>
          {approvals.map((approval) => <article key={approval.id}>
            <div><strong>{approval.summary}</strong><small>{approval.domain === "desktop" ? "Desktop app" : approval.domain ?? "Computer task"} · expires {new Date(approval.expiresAt).toLocaleTimeString()}</small></div>
            <div><button className="quiet" onClick={() => void decide(approval.id, "rejected")}>Reject</button><button onClick={() => void decide(approval.id, "approved")}>Approve</button></div>
          </article>)}
        </section>}

        <nav className="task-tabs" aria-label="Task views">
          <button className={tab === "attention" ? "active" : ""} onClick={() => setTab("attention")}>Waiting for you{attention ? ` · ${approvals.length}` : ""}</button>
          <button className={tab === "running" ? "active" : ""} onClick={() => setTab("running")}>Running{runningTasks.length ? ` · ${runningTasks.length}` : ""}</button>
          <button className={tab === "history" ? "active" : ""} onClick={() => setTab("history")}>Done</button>
        </nav>

        <section className="task-inbox">
          {visibleTasks.length === 0
            ? <div className="task-empty"><strong>{tab === "attention" ? "Nothing is waiting for you." : tab === "running" ? "Nothing is running." : "No finished tasks yet."}</strong></div>
            : visibleTasks.map((task) => <article className="task-card" key={task.id}>
              <div className={`run-state ${task.status}`}>{statusLabel(task.status)}</div>
              <div className="task-card-main"><small>{WORKFLOWS.find((item) => item.id === task.workflowType)?.title ?? "Computer task"}</small><h2>{task.objective}</h2>{task.status === "running" && latestStep(task) && <p className="task-now">Now: {latestStep(task)}</p>}{(task.result || task.error) && <p>{task.result ?? task.error}</p>}<button className="task-detail" type="button" onClick={() => document.getElementById(`task-${task.id}`)?.scrollIntoView({ behavior: "smooth" })}>Details</button></div>
              <time>{new Date(task.createdAt).toLocaleString()}</time>
            </article>)}
        </section>

        <section className="page-block task-composer" ref={taskComposerRef}>
          <h2>New task</h2>
          <div className="workflow-grid">
            {WORKFLOWS.map((item) => <button key={item.id} type="button" className={workflow === item.id ? "active" : ""} onClick={() => choose(item.id)}>
              <strong>{item.title}</strong><span>{item.summary}</span>
            </button>)}
          </div>
          <form className="mission-form" onSubmit={queue}>
            <label>What should Atlas do?
              <textarea aria-label="What should Atlas do?" value={objective} onChange={(event) => setObjective(event.target.value)} rows={6} maxLength={2000} required />
            </label>
            <label>Starting page <span>optional</span>
              <input value={startUrl} onChange={(event) => setStartUrl(event.target.value)} type="url" placeholder="https://…" />
            </label>
            <div className="field-row">
              <label>Run on
                <select aria-label="Browser execution provider" value={provider} onChange={(event) => setProvider(event.target.value as "windows" | "cloudflare")}>
                  <option value="windows">My computer</option>
                  <option value="cloudflare" disabled={!hostedReady}>Hosted browser{!capabilities?.providers.cloudflare.entitled ? " (Pro plan)" : !capabilities?.providers.cloudflare.configured ? " (not available yet)" : ` (${capabilities.providers.cloudflare.monthlyMinutes ?? "metered"} min/month)`}</option>
                </select>
              </label>
              {provider === "windows" && <label>Computer
                <select aria-label="Computer" value={deviceId} onChange={(event) => setDeviceId(event.target.value)}>
                  <option value="">{available.length ? "Choose a computer" : "None connected"}</option>
                  {available.map((device) => <option key={device.id} value={device.id}>{device.name} ({device.status})</option>)}
                </select>
              </label>}
            </div>
            <div className="mission-footer">
              <p>{active.guardrail}, and before any purchase, upload of sensitive files, or account change.</p>
              <div className="mission-send">
                {blocker && <small className="blocker" role="status">{blocker}</small>}
                <button disabled={busy || blocker !== "" || !objective.trim()}>{busy ? "Starting…" : "Start"}</button>
              </div>
            </div>
          </form>
        </section>

        <section className="page-block">
          <h2>Your computers</h2>
          <div className="pair-grid">
            <article className="pair-card">
              <p>Atlas does tasks on a Windows PC through the <Link href="/setup">Atlas companion app</Link>: in its own browser profile, or in desktop apps you allow. Screenshots stay on your computer.</p>
              <ol>
                <li>Name the PC and click Connect.</li>
                <li>Download the pairing file.</li>
                <li>Open it in the companion app on that PC.</li>
              </ol>
              <form onSubmit={pair}>
                <label>Computer name<input name="name" defaultValue="My Windows PC" maxLength={80} required /></label>
                <button disabled={busy}>Connect</button>
              </form>
              {credential && <div className="credential">
                <small>Only shown once</small><code>{credential}</code>
                <div className="credential-actions"><button className="primary" onClick={downloadPairing}>Download pairing file</button><button onClick={() => { void navigator.clipboard.writeText(credential).then(() => setCopied(true)).catch(() => setCopied(false)); }}>{copied ? "Copied" : "Copy"}</button></div>
              </div>}
              <ul className="device-list">
                {available.map((device) => <li key={device.id}>
                  <span>{device.name}<small>{device.status}</small></span>
                  <button onClick={() => void revoke(device.id)}>Disconnect</button>
                </li>)}
                {available.length === 0 && <li className="empty">No computers connected.</li>}
              </ul>
            </article>
          </div>
        </section>

        {tasks.length > 0 && <section className="page-block task-history-detail">
          <h2>All tasks</h2>
          {tasks.map((task) => <article className="run-row" id={`task-${task.id}`} key={task.id}>
            <span className={`run-state ${task.status}`}>{statusLabel(task.status)}</span>
            <div>
              <small>{WORKFLOWS.find((item) => item.id === task.workflowType)?.title ?? "Computer task"}</small>
              <strong>{task.objective}</strong>
              {(task.result || task.error) && <p>{task.result ?? task.error}</p>}
              {task.events?.length > 0 && <details className="task-timeline">
                <summary>Activity ({task.events.length})</summary>
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
        </section>}
      </div>
    </div>
  </AtlasShell>;
}
