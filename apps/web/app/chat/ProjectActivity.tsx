"use client";
import { useEffect, useState } from "react";
export type ProjectOperation = { operationId?: string; status: string; projectState?: string; message?: string | null; name?: string; visibility?: string; commit?: string | null; approvalId?: string | null; deploymentState?: string; repository?: { webUrl?: string; fullName?: string } | null };
const ACTIVE = ["recovering", "building", "publishing", "awaiting-approval"];
export function ProjectActivity({ operation }: { operation: ProjectOperation }) {
  const [snapshot, setSnapshot] = useState({ source: operation, value: operation });
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let active = true;
    let attempts = 0;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      attempts++;
      try {
        const response = await fetch(`/api/genesis/operations?id=${encodeURIComponent(operation.operationId!)}`, { cache: "no-store" });
        if (!active) return;
        if (!response.ok) {
          setSnapshot({ source: operation, value: { ...operation, status: "unavailable", message: "Project status could not be read. Sign in and check status again; no creation request was sent." } });
          return;
        }
        const result = await response.json() as ProjectOperation;
        if (!active) return;
        const pending = ACTIVE.includes(result.status);
        setSnapshot({ source: operation, value: { ...result, operationId: operation.operationId,
          ...(pending && attempts >= 60 ? { message: "Automatic status checks paused. Check status again to continue watching; this does not create another project." } : {}) } });
        if (pending && attempts < 60) timer = setTimeout(poll, 5000);
      } catch {
        if (active) setSnapshot({ source: operation, value: { ...operation, status: "unavailable", message: "The node could not be reached. Check status again when connected; creation remains unconfirmed." } });
      }
    };
    if (operation.operationId && (ACTIVE.includes(operation.status) || refresh > 0)) timer = setTimeout(poll, refresh > 0 ? 0 : 1000);
    return () => { active = false; clearTimeout(timer); };
  }, [operation, refresh]);
  const result = snapshot.source === operation ? snapshot.value : operation;
  const url = result.repository?.webUrl;
  const safeUrl = url && /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/u.test(url) ? url : null;
  return <article className="suggestion-card" aria-live="polite">
    <strong>{result.status === "published" ? "Repository created and pushed" : `New project: ${result.status}`}</strong>
    <p>{[result.name, result.visibility, result.projectState].filter(Boolean).join(" · ")}</p>
    {safeUrl && <a href={safeUrl} target="_blank" rel="noreferrer">{result.repository?.fullName ?? safeUrl} ↗</a>}
    {result.commit && <p>Initial commit: <code>{result.commit}</code></p>}
    <p>{result.message ?? (result.status === "awaiting-approval" ? "Approve the exact publish action in the Genesis node’s Approvals page." : "")}</p>
    <small>Operation: {result.operationId ?? "unavailable"} · Deployment: {result.deploymentState ?? "not-deployed"}</small>
    {result.operationId && result.status !== "published" && <button type="button" onClick={() => setRefresh((value) => value + 1)}>Check project status</button>}
  </article>;
}
