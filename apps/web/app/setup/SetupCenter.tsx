"use client";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { AtlasShell } from "../AtlasShell.js";
import { chatRouteSummary, providerChecks, quotaSummary, toneClass } from "./chat-health.mjs";

type SetupStep = { id: string; label: string; state: "complete" | "action-required" | "failed"; detail: string; action?: string };
type SetupStatus = { audience?: "customer" | "owner"; overall: string; completedSteps: number; totalSteps: number; steps: SetupStep[]; optional: { stripeConfigured?: boolean; chat?: unknown; inferenceGovernor?: unknown } };
type ProviderCheck = ReturnType<typeof providerChecks>[number];
type ProviderState = { phase: "idle" } | { phase: "checking" } | { phase: "done"; checks: ProviderCheck[]; at: string } | { phase: "error"; message: string };

/** A real provider check makes up to four sequential calls with 15-second limits each. */
const PROVIDER_CHECK_DEADLINE_MS = 65000;

function validStatus(value: unknown): value is SetupStatus {
  if (!value || typeof value !== "object") return false;
  const status = value as Partial<SetupStatus>;
  return (status.audience === "customer" || status.audience === "owner")
    && typeof status.overall === "string"
    && Number.isInteger(status.completedSteps) && Number.isInteger(status.totalSteps)
    && status.completedSteps! >= 0 && status.completedSteps! <= status.totalSteps!
    && Array.isArray(status.steps) && status.steps.length === status.totalSteps
    && status.steps.every(item => item && typeof item.id === "string" && typeof item.label === "string"
      && typeof item.detail === "string" && ["complete", "action-required", "failed"].includes(item.state)
      && (item.action === undefined || typeof item.action === "string"))
    && Boolean(status.optional && typeof status.optional === "object" && !Array.isArray(status.optional));
}
type GitHub = { connected: boolean; method: string; installUrl: string | null };

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
  const [model, setModel] = useState<{ configured: boolean; reason: string | null } | null>(null);
  const [repository, setRepository] = useState("");
  const [repositoryOptions, setRepositoryOptions] = useState<string[]>([]);
  const [mergePolicy, setMergePolicy] = useState("manual");
  const [policyNotice, setPolicyNotice] = useState("");
  const [error, setError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const statusRequest = useRef<{ generation: number; controller: AbortController | null }>({ generation: 0, controller: null });
  const [providers, setProviders] = useState<ProviderState>({ phase: "idle" });
  const providerRequest = useRef<AbortController | null>(null);

  useEffect(() => () => providerRequest.current?.abort(), []);

  /**
   * Runs only when the owner asks: each check sends one tiny real inference,
   * which spends a little provider quota, and quota is what is scarce.
   */
  async function checkProviders() {
    providerRequest.current?.abort();
    const controller = new AbortController();
    providerRequest.current = controller;
    const deadline = setTimeout(() => controller.abort(), PROVIDER_CHECK_DEADLINE_MS);
    setProviders({ phase: "checking" });
    try {
      const response = await fetch("/api/setup/providers", { cache: "no-store", signal: controller.signal });
      if (response.status === 401) { window.location.href = "/"; return; }
      if (response.status === 403) throw new Error("Only the deployment owner can run provider checks.");
      if (!response.ok) throw new Error("Provider checks are unavailable right now. Try again shortly.");
      const checks = providerChecks(await response.json());
      if (providerRequest.current === controller) setProviders({ phase: "done", checks, at: new Date().toISOString().slice(11, 16) });
    } catch (failure) {
      if (providerRequest.current !== controller) return;
      const message = controller.signal.aborted
        ? "The provider check took too long. Try again shortly."
        : failure instanceof Error && failure.message.startsWith("Only the deployment owner") ? failure.message : "Provider checks are unavailable right now. Try again shortly.";
      setProviders({ phase: "error", message });
    } finally {
      clearTimeout(deadline);
      if (providerRequest.current === controller) providerRequest.current = null;
    }
  }

  const refresh = useCallback(async () => {
    const generation = ++statusRequest.current.generation;
    statusRequest.current.controller?.abort();
    const controller = new AbortController();
    statusRequest.current.controller = controller;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    setRefreshing(true);
    try {
      const result = await Promise.race([
        (async () => {
          const response = await fetch("/api/setup/status", { cache: "no-store", signal: controller.signal });
          if (response.status === 401) return { signedOut: true } as const;
          if (!response.ok) throw new Error("Status unavailable");
          const value: unknown = await response.json();
          if (!validStatus(value)) throw new Error("Invalid status");
          return { status: value };
        })(),
        new Promise<never>((_, reject) => {
          deadline = setTimeout(() => { controller.abort(); reject(new Error("Status deadline")); }, 12000);
        }),
      ]);
      if (generation !== statusRequest.current.generation) return;
      if ("signedOut" in result) { window.location.href = "/"; return; }
      setStatus(result.status);
      setError("");
    } catch {
      if (generation === statusRequest.current.generation) setError("Connection status is temporarily unavailable. Refresh or contact support.");
    } finally {
      clearTimeout(deadline);
      if (generation === statusRequest.current.generation) {
        statusRequest.current.controller = null;
        setRefreshing(false);
      }
    }
  }, []);

  // Deferred a tick so the first render is not a cascading re-render.
  useEffect(() => {
    const timer = window.setTimeout(() => void refresh(), 0);
    const request = statusRequest.current;
    return () => { window.clearTimeout(timer); request.generation++; request.controller?.abort(); };
  }, [refresh]);

  useEffect(() => {
    let active = true;
    void Promise.all([
      fetch("/api/github/status").then((response) => (response.ok ? response.json() : null)).catch(() => null),
      fetch("/api/chat", { cache: "no-store" }).then((response) => (response.ok ? response.json() : null)).catch(() => null),
      fetch("/api/github/options").then((response) => (response.ok ? response.json() : null)).catch(() => null),
    ]).then(([status, chat, options]) => {
      if (!active) return;
      if (status) setGitHub(status as GitHub);
      if (chat) setModel(chat as { configured: boolean; reason: string | null });
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

  const owner = status?.audience === "owner";
  const sectionNumber = (base: number) => String(owner && base > 1 ? base + 1 : base).padStart(2, "0");
  const route = owner && status ? chatRouteSummary(status.optional.chat) : null;
  const quota = owner && status ? quotaSummary(status.optional.inferenceGovernor) : null;

  return <AtlasShell section="connections" headerContext={
    <span className="context-chip">{status?.audience === "customer" ? "Account connected" : status ? `${status.completedSteps}/${status.totalSteps} ready` : "Checking…"}</span>
  }>
    <div className="section-scroll">
      <div className="section-page">
        <header className="page-head">
          <p className="kicker">CONNECTIONS</p>
          <h1>Everything Atlas is plugged into.</h1>
          <p>What is set up, what still needs you, and how far Atlas may go on its own.</p>
        </header>

        <section className="page-block">
          <h2><span>{sectionNumber(1)}</span>Live status</h2>
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
                : status?.audience === "owner" ? model?.reason ?? "Chat cannot answer until a model endpoint is configured." : "Chat is temporarily unavailable. Refresh or contact support."}</p>
            </article>
            <article className="status-card">
              <small>COMPUTER</small>
              <strong>Connect from Computer control</strong>
              <p>The Windows companion app connects with a one-time pairing file and uses its own browser profile on your PC.</p>
              <Link href="/automation">Open Computer control →</Link>
            </article>
          </div>
        </section>

        {owner && route && quota && <section className="page-block" aria-labelledby="chat-health-heading">
          <h2 id="chat-health-heading"><span>02</span>Chat providers and quota</h2>
          <p className="block-hint">Which model providers chat uses, and whether any of them is at a limit. Only you can see this.</p>
          <div className="status-grid">
            <article className={toneClass(route.tone)}>
              <small>CHAT ROUTE</small>
              <strong>{route.headline}</strong>
              <p>{route.detail}</p>
            </article>
            <article className={toneClass(quota.tone)}>
              <small>QUOTA</small>
              <strong>{quota.headline}</strong>
              <p>{quota.detail}</p>
            </article>
          </div>
          <p className="block-hint provider-check-hint">The provider check sends one short test message to each provider and reports whether its credential works. It uses a little quota, so it only runs when you ask.</p>
          <button className="page-action" type="button" onClick={() => void checkProviders()} disabled={providers.phase === "checking"}>
            {providers.phase === "checking" ? "Checking providers…" : providers.phase === "done" ? "Check providers again" : "Check providers"}
          </button>
          <div aria-live="polite">
            {providers.phase === "checking" && <p className="block-hint provider-check-hint" role="status">Checking each provider. This can take up to a minute.</p>}
            {providers.phase === "error" && <p className="page-notice" role="alert">{providers.message}</p>}
            {providers.phase === "done" && <>
              <p className="block-hint provider-check-hint" role="status">Checked at {providers.at} UTC.</p>
              <div className="status-grid">
                {providers.checks.map((check) => <article className={toneClass(check.tone)} key={check.id}>
                  <small>{check.label.toUpperCase()}</small>
                  <strong>{check.headline}</strong>
                  <p>{check.detail}</p>
                </article>)}
              </div>
            </>}
          </div>
        </section>}

        <section className="page-block">
          <h2><span>{sectionNumber(2)}</span>How far Atlas may go</h2>
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
          <h2><span>{sectionNumber(3)}</span>{status?.audience === "customer" ? "Account status" : "Setup checklist"}</h2>
          {error && <p className="page-notice" role="alert">{error}</p>}
          {!status && !error && <p className="block-hint">Checking the live environment…</p>}
          <div className="check-list">
            {status?.steps.map((item, index) => <article className={`check-row ${item.state}`} key={item.id}>
              <div className="check-number">{String(index + 1).padStart(2, "0")}</div>
              <div><div className="check-state">{item.state.replace("-", " ")}</div><h3>{item.label}</h3><p>{item.detail}</p></div>
              {item.state !== "complete" && <span className="check-action">{item.action ?? "Action required"}</span>}
            </article>)}
            {status?.audience === "owner" && <article className="check-row optional">
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
