"use client";
import { useEffect, useState } from "react";
export type ProjectOperation = { operationId?: string; status: string; projectState?: string; message?: string | null; name?: string; visibility?: string; commit?: string | null; approvalId?: string | null; deploymentState?: string; repository?: { webUrl?: string; fullName?: string } | null };
export function ProjectActivity({ operation }: { operation: ProjectOperation }) {
  const [snapshot, setSnapshot] = useState({ source: operation, value: operation });
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const response = await fetch(`/api/genesis/operations?id=${encodeURIComponent(operation.operationId!)}`);
        if (!response.ok) {
          if (active) timer = setTimeout(poll, 10000);
          return;
        }
        const result = await response.json() as ProjectOperation;
        if (!active) return;
        setSnapshot({ source: operation, value: result });
        if (["building", "publishing", "awaiting-approval"].includes(result.status)) timer = setTimeout(poll, 5000);
      } catch { if (active) timer = setTimeout(poll, 10000); }
    };
    if (operation.operationId && ["building", "publishing", "awaiting-approval"].includes(operation.status)) timer = setTimeout(poll, 1000);
    return () => { active = false; clearTimeout(timer); };
  }, [operation]);
  const result = snapshot.source === operation ? snapshot.value : operation;
  const url = result.repository?.webUrl;
  const safeUrl = url && /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/u.test(url) ? url : null;
  return <article className="suggestion-card" aria-live="polite">
    <strong>{result.status === "published" ? "Repository created and pushed" : `New project: ${result.status}`}</strong>
    <p>{result.name} · {result.visibility} · {result.projectState ?? "planning"}</p>
    {safeUrl && <a href={safeUrl} target="_blank" rel="noreferrer">{result.repository?.fullName ?? safeUrl} ↗</a>}
    {result.commit && <p>Initial commit: <code>{result.commit}</code></p>}
    <p>{result.message ?? (result.status === "awaiting-approval" ? "Approve the exact publish action in the Genesis node’s Approvals page." : "")}</p>
    <small>Operation: {result.operationId ?? "unavailable"} · Deployment: {result.deploymentState ?? "not-deployed"}</small>
  </article>;
}
