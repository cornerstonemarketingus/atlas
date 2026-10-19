"use client";
import { useEffect, useState } from "react";
import { describeProject } from "./project-state.mjs";
export type ProjectOperation = { operationId?: string; status: string; projectState?: string; message?: string | null; reason?: string | null; nextStep?: string | null; name?: string; visibility?: string; commit?: string | null; approvalId?: string | null; deploymentState?: string; repository?: { webUrl?: string; fullName?: string } | null };
export function ProjectActivity({ operation }: { operation: ProjectOperation }) {
  const [snapshot, setSnapshot] = useState({ source: operation, value: operation });
  const [pollFailed, setPollFailed] = useState(false);
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const response = await fetch(`/api/genesis/operations?id=${encodeURIComponent(operation.operationId!)}`);
        if (!response.ok) {
          if (active) { setPollFailed(true); timer = setTimeout(poll, 10000); }
          return;
        }
        const result = await response.json() as ProjectOperation;
        if (!active) return;
        setPollFailed(false);
        setSnapshot({ source: operation, value: result });
        if (describeProject(result).polling) timer = setTimeout(poll, 5000);
      } catch { if (active) { setPollFailed(true); timer = setTimeout(poll, 10000); } }
    };
    if (operation.operationId && describeProject(operation).polling) timer = setTimeout(poll, 1000);
    return () => { active = false; clearTimeout(timer); };
  }, [operation]);
  const result = snapshot.source === operation ? snapshot.value : operation;
  const view = describeProject(result);
  const url = result.repository?.webUrl;
  const safeUrl = url && /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/u.test(url) ? url : null;
  return <article className="suggestion-card" aria-live="polite" data-stage={view.stage}>
    <strong>{view.title}</strong>
    {view.detail && <p>{view.detail}</p>}
    {view.nextStep && <p><b>What to do:</b> {view.nextStep}</p>}
    {safeUrl && <a href={safeUrl} target="_blank" rel="noreferrer">{result.repository?.fullName ?? safeUrl} ↗</a>}
    {result.commit && <p>Initial commit: <code>{result.commit}</code></p>}
    {pollFailed && <p role="alert">Progress could not be refreshed just now. Retrying; the last confirmed status is shown.</p>}
    {view.facts.length > 0 && <small>{view.facts.map((fact) => `${fact.label}: ${fact.value}`).join(" · ")}</small>}
  </article>;
}
