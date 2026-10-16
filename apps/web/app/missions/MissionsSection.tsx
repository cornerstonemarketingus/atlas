"use client";
import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { AtlasShell } from "../AtlasShell.js";
import "./missions.css";
import { missionRequest as api } from "./request.mjs";
type Step = { id: string; objective: string; state: string; taskId: string | null; message: string | null; evidence?: { runUrl?: string | null; summary?: string; receiptId?: string | null } | null };
type Mission = { id: string; objective: string; status: string; revision: number; dispatchCount: number; dispatchLimit: number; steps: Step[] };
type Summary = Pick<Mission, "id" | "objective" | "status">;
function safeRunUrl(value?: string | null) { try { const url = new URL(value ?? ""); return url.protocol === "https:" && url.hostname === "github.com" ? url.href : null; } catch { return null; } }
export function MissionsSection() {
  const [missions, setMissions] = useState<Summary[]>([]);
  const [mission, setMission] = useState<Mission | null>(null);
  const [objective, setObjective] = useState("");
  const [repository, setRepository] = useState("");
  const [branch, setBranch] = useState("main");
  const [mode, setMode] = useState("inspect");
  const [steps, setSteps] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const requestId = useRef<string | null>(null);
  const generation = useRef(0);
  const invalidate = useCallback(() => { generation.current++; }, []);
  const working = useRef(false);
  const selected = useRef<string | null>(null);
  const refresh = async () => { const result = await api("/api/missions"); setMissions(result.missions); };
  useEffect(() => { let active = true; void api("/api/missions").then(result => { if (active) setMissions(result.missions); }).catch(error => { if (active) setNotice(error.message); }); return () => { active = false; invalidate(); }; }, [invalidate]);
  async function open(id: string) {
    const current = ++generation.current; selected.current = id; setMission(null); setNotice("");
    try { const result = await api(`/api/missions/${id}`); if (current === generation.current) setMission(result.mission); }
    catch (error) { if (current === generation.current) setNotice((error as Error).message); }
  }
  const activeId = mission?.id;
  const activeStatus = mission?.status;
  const hasPendingWork = mission?.steps.some(step => ["dispatching", "uncertain", "submitted"].includes(step.state)) ?? false;
  useEffect(() => {
    if (!activeId || !["running", "paused", "stopped"].includes(activeStatus ?? "") || !hasPendingWork) return;
    const id = activeId; let active = true; let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      const current = generation.current;
      try {
        if (!working.current) {
          const result = await api(`/api/missions/${id}`, { action: "advance" });
          if (active && selected.current === id && current === generation.current) { setMission(result.mission); setMissions(items => items.map(item => item.id === id ? { ...item, status: result.mission.status } : item)); }
        }
      } catch (error) { if (active && current === generation.current) setNotice((error as Error).message); }
      finally { if (active) timer = setTimeout(poll, 10000); }
    };
    timer = setTimeout(poll, 10000);
    return () => { active = false; clearTimeout(timer); };
  }, [activeId, activeStatus, hasPendingWork]);
  async function save(event: FormEvent) {
    event.preventDefault(); if (working.current) return;
    working.current = true; setBusy(true); setNotice(""); const current = ++generation.current;
    requestId.current ??= crypto.randomUUID();
    try {
      const objectives = steps.split(/\r?\n/u).map(value => value.trim()).filter(Boolean);
      const result = await api("/api/missions", { requestId: requestId.current, objective, steps: objectives.map((text, index) => ({ id: `step-${index + 1}`, dependencies: index ? [`step-${index}`] : [], repository, branch, mode, objective: text })) });
      if (current !== generation.current) return;
      selected.current = result.mission.id; setMission(result.mission); await refresh();
    } catch (error) { if (current === generation.current) setNotice((error as Error).message); }
    finally { working.current = false; setBusy(false); }
  }
  async function control(action: string) {
    if (!mission || working.current) return;
    working.current = true; setBusy(true); setNotice(""); const current = ++generation.current; const id = mission.id;
    try { const result = await api(`/api/missions/${id}`, { action }); if (current === generation.current) { setMission(result.mission); await refresh(); } }
    catch (error) { if (current === generation.current) setNotice((error as Error).message); }
    finally { working.current = false; setBusy(false); }
  }
  function edited() { requestId.current = null; }
  return <AtlasShell section="missions"><section className="section-scroll"><div className="cloud-missions">
    <header><p className="eyebrow">CLOUD MISSIONS</p><h1>Work that survives reconnecting</h1><p>Plan up to eight repository tasks. Atlas saves dispatch intent and requires recorded runner results before advancing.</p><Link href="/">Back to chat</Link></header>
    {notice && <p className="mission-notice" role="status">{notice}</p>}
    <form className="cloud-mission-form" onSubmit={save} onChange={edited}>
      <h2>Create a mission</h2><label>Overall objective<textarea value={objective} onChange={event => setObjective(event.target.value)} maxLength={4000} required /></label>
      <label>Connected repository<input placeholder="owner/repository" value={repository} onChange={event => setRepository(event.target.value)} required /></label>
      <label>Branch<input value={branch} onChange={event => setBranch(event.target.value)} required /></label>
      <label>Work to perform<select value={mode} onChange={event => setMode(event.target.value)}><option value="inspect">Inspect and report</option><option value="debug">Run checks and diagnose</option><option value="coder">Implement and verify changes</option></select></label>
      <label>Steps, one concrete objective per line<textarea value={steps} onChange={event => setSteps(event.target.value)} rows={5} maxLength={32000} required /></label>
      <p>Each step can start one task and consumes your normal task allowance. Steps run sequentially on the branches you specify; code changes are not automatically combined.</p><button disabled={busy}>Save mission</button>
    </form>
    <section><h2>Saved missions</h2><div className="mission-list">{missions.map(item => <button key={item.id} onClick={() => void open(item.id)}>{item.objective} <small>{item.status}</small></button>)}{!missions.length && <p>No saved missions yet.</p>}</div></section>
    {mission && <section className="mission-detail"><h2>{mission.objective}</h2><p><strong>{mission.status}</strong> · {mission.dispatchCount}/{mission.dispatchLimit} dispatch attempts</p>
      <div className="mission-controls">{!["completed", "failed", "stopped"].includes(mission.status) && <><button disabled={busy} onClick={() => void control(mission.status === "paused" ? "resume" : "advance")}>{mission.status === "paused" ? "Resume" : "Start / reconcile"}</button><button disabled={busy} onClick={() => void control("pause")}>Pause future steps</button><button disabled={busy} onClick={() => void control("stop")}>Stop future steps</button></>}</div>
      <p>A running cloud task can finish while this page is closed. Reopen the mission to reconcile its result and continue. Pausing or stopping prevents new steps; it does not cancel a runner already working.</p>
      <ol>{mission.steps.map(step => { const url = safeRunUrl(step.evidence?.runUrl); return <li key={step.id}><strong>{step.state}</strong><p>{step.objective}</p>{step.message && <p>{step.message}</p>}{step.taskId && <small>Task: {step.taskId}</small>}{url && <p><a href={url} target="_blank" rel="noreferrer">Verified run ↗</a></p>}{step.evidence?.summary && <pre>{step.evidence.summary}</pre>}</li>; })}</ol>
    </section>}
  </div></section></AtlasShell>;
}
