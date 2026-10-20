"use client";
import { useEffect, useState } from "react";
import { describeProject } from "./project-state.mjs";
export type ProjectOperation = { operationId?: string; status: string; projectState?: string; message?: string | null; reason?: string | null; nextStep?: string | null; name?: string; visibility?: string; commit?: string | null; previewUrl?: string | null; pages?: { title: string; path: string }[]; approvalId?: string | null; deploymentState?: string; repository?: { webUrl?: string; fullName?: string } | null };
export function ProjectActivity({ operation }: { operation: ProjectOperation }) {
  const [snapshot, setSnapshot] = useState({ source: operation, value: operation });
  const [pollFailed, setPollFailed] = useState(false);
  const [pollPaused, setPollPaused] = useState(false);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let active = true;
    let attempts = 0;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      attempts++;
      try {
        const response = await fetch(`/api/genesis/operations?id=${encodeURIComponent(operation.operationId!)}`, { cache: "no-store", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]) });
        if (!active) return;
        if (!response.ok) {
          setPollFailed(true);
          return;
        }
        const result = await response.json() as ProjectOperation;
        if (!active) return;
        setPollFailed(false);
        setPollPaused(describeProject(result).polling && attempts >= 60);
        setSnapshot({ source: operation, value: { ...result, operationId: operation.operationId } });
        if (describeProject(result).polling && attempts < 60) timer = setTimeout(poll, 5000);
      } catch { if (active) setPollFailed(true); }
    };
    if (operation.operationId && (operation.status === "recovering" || describeProject(operation).polling || refresh > 0)) timer = setTimeout(poll, refresh > 0 ? 0 : 1000);
    return () => { active = false; controller.abort(); clearTimeout(timer); };
  }, [operation, refresh]);
  const result = snapshot.source === operation ? snapshot.value : operation;
  const view = describeProject(result);
  const url = result.repository?.webUrl;
  const safeUrl = url && /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/u.test(url) ? url : null;
  return <article className="suggestion-card" aria-live="polite" data-stage={view.stage}>
    <strong>{view.title}</strong>
    {view.detail && <p>{view.detail}</p>}
    {view.nextStep && <p><b>What to do:</b> {view.nextStep}</p>}
    {view.previewUrl && <p><a href={view.previewUrl} target="_blank" rel="noreferrer">Open the preview ↗</a></p>}
    {view.previewUrl && result.pages && result.pages.length > 0 && <p>{result.pages.map((page) => page.title).join(" · ")}</p>}
    {safeUrl && <a href={safeUrl} target="_blank" rel="noreferrer">{result.repository?.fullName ?? safeUrl} ↗</a>}
    {result.commit && <p>Initial commit: <code>{result.commit}</code></p>}
    {pollFailed && <p role="alert">Progress could not be refreshed. The last confirmed status is shown. Check status again when connected; no creation request was sent.</p>}
    {pollPaused && <p>Automatic status checks paused. Check status again to continue watching; this does not create another project.</p>}
    {result.operationId && view.stage !== "completed" && <button type="button" onClick={() => setRefresh(value => value + 1)}>Check project status</button>}
    {view.facts.length > 0 && <small>{view.facts.map((fact) => `${fact.label}: ${fact.value}`).join(" · ")}</small>}
  </article>;
}
