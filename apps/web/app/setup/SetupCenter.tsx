"use client";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { AtlasShell } from "../AtlasShell.js";

type SetupStep = { id: string; label: string; state: "complete" | "action-required" | "failed"; detail: string; action?: string };
type SetupStatus = { overall: string; completedSteps: number; totalSteps: number; steps: SetupStep[]; optional: { stripeConfigured: boolean } };
type GitHub = { connected: boolean; method: string; installUrl: string | null };
type ChatModelStatus = { configured: boolean; reason: string | null; routes?: { purpose: string; route: string; endpoint: string }[]; lastServedModel?: string | null };

const MERGE_POLICIES = [
  { id: "manual", label: "Review first: a person merges each pull request" },
  { id: "ci-gated", label: "Merge automatically once all tests pass (default)" },
  { id: "none", label: "Merge right away, without waiting for tests (not recommended)" },
];

/**
 * Connections: everything Atlas needs wired up, in one place.
 *
 * The checklist was already here; the GitHub connection, the merge policy and
 * the chat model endpoint were scattered across a legacy dashboard and two
 * other pages, which is why nobody could find them.
 */
export function SetupCenter() {
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [github, setGitHub] = useState<GitHub | null>(null);
  const [model, setModel] = useState<ChatModelStatus | null>(null);
  const [repository, setRepository] = useState("");
  const [repositoryOptions, setRepositoryOptions] = useState<string[]>([]);
  const [mergePolicy, setMergePolicy] = useState("manual");
  const [policyNotice, setPolicyNotice] = useState("");
  const [error, setError] = useState("");
  const [refreshing, setRefreshing] = useState(false);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const response = await fetch("/api/setup/status", { cache: "no-store" });
      if (response.status === 401) { window.location.href = "/"; return; }
      if (!response.ok) throw new Error("Setup readiness is temporarily unavailable.");
      setStatus(await response.json() as SetupStatus);
      setError("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Setup readiness is temporarily unavailable.");
    } finally {
      setRefreshing(false);
    }
  }, []);

  // Deferred a tick so the first render is not a cascading re-render.
  useEffect(() => { const timer = window.setTimeout(() => void refresh(), 0); return () => window.clearTimeout(timer); }, [refresh]);

  useEffect(() => {
    let active = true;
    void Promise.all([
      fetch("/api/github/status").then((response) => (response.ok ? response.json() : null)).catch(() => null),
      fetch("/api/chat", { cache: "no-store" }).then((response) => (response.ok ? response.json() : null)).catch(() => null),
      fetch("/api/github/options").then((response) => (response.ok ? response.json() : null)).catch(() => null),
    ]).then(([status, chat, options]) => {
      if (!active) return;
      if (status) setGitHub(status as GitHub);
      if (chat) {
        const next = chat as ChatModelStatus;
        const last = window.localStorage.getItem("atlas.lastServedModel");
        setModel(next.lastServedModel ? next : { ...next, ...(last ? { lastServedModel: last } : {}) });
      }
      const names = (options as { repositories?: string[] } | null)?.repositories ?? [];
      if (names.length) { setRepositoryOptions(names); setRepository((current) => current || names[0]); }
    });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!repository.includes("/")) return;
    const [owner, name] = repository.split("/");
    let active = true;
    void fetch("/api/settings/repositories")
      .then((response) => (response.ok ? response.json() : null))
      .then((value) => {
        if (!active || !value) return;
        const match = (value as { repositories: { owner: string; name: string; mergePolicy: string }[] }).repositories
          .find((row) => row.owner === owner.toLowerCase() && row.name === name.toLowerCase());
        setMergePolicy(match?.mergePolicy ?? "manual");
      })
      .catch(() => undefined);
    return () => { active = false; };
  }, [repository]);

  async function savePolicy(next: string) {
    const [owner, name] = repository.split("/");
    if (!owner || !name) { setPolicyNotice("Choose a project first."); return; }
    setMergePolicy(next);
    try {
      const response = await fetch("/api/settings/repositories", {
        method: "PUT", headers: { "content-type": "application/json" },
        body: JSON.stringify({ owner, name, mergePolicy: next }),
      });
      const result = await response.json() as { message?: string };
      setPolicyNotice(response.ok ? "Saved." : result.message ?? "Could not save the merge policy.");
    } catch {
      setPolicyNotice("The settings service is temporarily unavailable.");
    }
  }

  return <AtlasShell section="connections" headerContext={
    <span className="context-chip">{status ? `${status.completedSteps}/${status.totalSteps} ready` : "Checking…"}</span>
  }>
    <div className="section-scroll">
      <div className="section-page">
        <header className="page-head">
          <p className="kicker">CONNECTIONS</p>
          <h1>Everything Atlas is plugged into.</h1>
          <p>What is set up, what still needs you, and how far Atlas may go on its own.</p>
        </header>

        <section className="page-block">
          <h2><span>01</span>Live status</h2>
          <div className="status-grid">
            <article className={github?.connected ? "status-card good" : "status-card"}>
              <small>GITHUB</small>
              <strong>{github === null ? "Checking…" : github.connected ? `Connected via ${github.method}` : "Not connected"}</strong>
              <p>Atlas needs GitHub access to read your projects and open pull requests.</p>
              {github?.installUrl && !github.connected && <a href={github.installUrl} rel="noreferrer">Install the GitHub App ↗</a>}
            </article>
            <article className={model?.configured ? "status-card good" : "status-card"}>
              <small>CHAT MODEL</small>
              <strong>{model === null ? "Checking…" : model.configured ? "Model endpoint connected" : "No model endpoint"}</strong>
              <p>{model?.configured
                ? "Chat is connected. Atlas works with any OpenAI-compatible model server, hosted or your own."
                : model?.reason ?? "Chat cannot answer until a model endpoint is configured."}</p>
              {model?.lastServedModel && <p>Last served: <code>{model.lastServedModel}</code></p>}
              {!!model?.routes?.length && <table>
                <caption>Configured model routes</caption>
                <thead><tr><th>Purpose</th><th>Route</th><th>Endpoint</th></tr></thead>
                <tbody>
                  {model.routes.map((item, index) => <tr key={`${item.purpose}:${item.route}:${index}`}>
                    <td>{item.purpose}</td><td><code>{item.route}</code></td><td><code>{item.endpoint || "configured at runtime"}</code></td>
                  </tr>)}
                </tbody>
              </table>}
            </article>
            <article className="status-card">
              <small>COMPUTER</small>
              <strong>Connect from Computer control</strong>
              <p>The Windows companion app connects with a one-time pairing file and uses its own browser profile on your PC.</p>
              <Link href="/automation">Open Computer control →</Link>
            </article>
          </div>
        </section>

        <section className="page-block">
          <h2><span>02</span>How far Atlas may go</h2>
          <p className="block-hint">Code changes always arrive as a pull request. Choose what happens to it next.</p>
          <div className="policy-row">
            <label>Project
              <select aria-label="Project" value={repository} onChange={(event) => setRepository(event.target.value)}>
                {repositoryOptions.length === 0 && <option value="">No projects available</option>}
                {repositoryOptions.map((name) => <option key={name}>{name}</option>)}
              </select>
            </label>
            <label>Merge policy
              <select aria-label="Merge policy" value={mergePolicy} disabled={!repository} onChange={(event) => void savePolicy(event.target.value)}>
                {MERGE_POLICIES.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
              </select>
            </label>
          </div>
          {policyNotice && <p className="page-notice" role="status">{policyNotice}</p>}
        </section>

        <section className="page-block">
          <h2><span>03</span>Setup checklist</h2>
          {error && <p className="page-notice" role="alert">{error}</p>}
          {!status && !error && <p className="block-hint">Checking the live environment…</p>}
          <div className="check-list">
            {status?.steps.map((item, index) => <article className={`check-row ${item.state}`} key={item.id}>
              <div className="check-number">{String(index + 1).padStart(2, "0")}</div>
              <div><div className="check-state">{item.state.replace("-", " ")}</div><h3>{item.label}</h3><p>{item.detail}</p></div>
              {item.state !== "complete" && <span className="check-action">{item.action ?? "Action required"}</span>}
            </article>)}
            {status && <article className="check-row optional">
              <div className="check-number">+</div>
              <div><div className="check-state">Optional</div><h3>Stripe billing</h3>
                <p>{status.optional.stripeConfigured ? "Billing credentials are configured." : "Add billing when you are ready to charge customers."}</p></div>
            </article>}
          </div>
          <button className="page-action" type="button" onClick={() => void refresh()} disabled={refreshing}>
            {refreshing ? "Refreshing…" : "Refresh live status"}
          </button>
        </section>
      </div>
    </div>
  </AtlasShell>;
}
