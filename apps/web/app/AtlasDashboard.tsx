"use client";
import { FormEvent, useState } from "react";

const activity = [
  { title: "Repository intelligence foundation", detail: "145 checks passed", status: "Shipped" },
  { title: "GitHub repository host", detail: "Read-only adapter connected", status: "Ready" },
  { title: "Hosted control plane", detail: "Deployment candidate", status: "Building" },
];

export function AtlasDashboard() {
  const [objective, setObjective] = useState("");
  const [notice, setNotice] = useState("");
  const [submitting, setSubmitting] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!objective.trim()) return;
    setSubmitting(true); setNotice("");
    try {
      const response = await fetch("/api/tasks", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ repository: "cornerstonemarketingus/atlas", objective }) });
      const result = (await response.json()) as { message?: string; taskId?: string };
      setNotice(response.ok ? `Task ${result.taskId ?? "queued"} is awaiting approval.` : result.message ?? "Task dispatch is not configured yet.");
      if (response.ok) setObjective("");
    } catch { setNotice("The task dispatcher is temporarily unavailable."); }
    finally { setSubmitting(false); }
  }
  return <main>
    <header className="topbar"><a className="brand" href="#top"><span className="brandmark">A</span>ATLAS</a><nav><a href="#mission">Mission</a><a href="#activity">Activity</a><a href="#runtime">Runtime</a></nav><span className="online"><i /> Control plane online</span></header>
    <section className="hero" id="top"><div className="eyebrow"><span>01</span> Autonomous engineering, under control</div><h1>From intent to<br /><em>verified change.</em></h1><p className="lede">Atlas understands your repository, proposes a bounded change, validates it, and commits only after policy and approval gates pass.</p>
      <form className="command" onSubmit={submit}><label htmlFor="objective">What should Atlas build next?</label><div><span className="prompt">›</span><input id="objective" value={objective} onChange={(event) => setObjective(event.target.value)} placeholder="Add an API, repair a failing test, improve the architecture…" /><button disabled={submitting}>{submitting ? "QUEUING" : "START TASK"}</button></div><small>Target: cornerstonemarketingus/atlas · commit requires approval</small></form>{notice && <p className="notice" role="status">{notice}</p>}
    </section>
    <section className="metrics"><article><strong>145</strong><span>VALIDATION CHECKS</span></article><article><strong>05</strong><span>READ-ONLY TOOLS</span></article><article><strong>00</strong><span>UNREVIEWED COMMITS</span></article><article><strong>LOCAL</strong><span>DEFAULT MODEL ROUTE</span></article></section>
    <section className="split" id="mission"><div><div className="eyebrow"><span>02</span> Operating model</div><h2>Autonomy with<br />hard boundaries.</h2></div><div className="principles"><article><b>01</b><div><h3>Understand first</h3><p>Deterministic repository maps, symbols, references, manifests, and source evidence.</p></div></article><article><b>02</b><div><h3>Preview every mutation</h3><p>Exact diffs, scoped capabilities, expiring approvals, and optimistic concurrency.</p></div></article><article><b>03</b><div><h3>Prove the result</h3><p>Baseline-aware builds and tests distinguish new failures from existing conditions.</p></div></article></div></section>
    <section className="activity" id="activity"><div className="sectionhead"><div><div className="eyebrow"><span>03</span> Build progression</div><h2>System activity</h2></div><span className="branch">agent/initial-atlas-cli-foundation</span></div><div className="activitygrid">{activity.map((item,index)=><article key={item.title}><span className="index">0{index+1}</span><div><h3>{item.title}</h3><p>{item.detail}</p></div><mark className={item.status.toLowerCase()}>{item.status}</mark></article>)}</div></section>
    <section className="runtime" id="runtime"><div><div className="eyebrow light"><span>04</span> Inference strategy</div><h2>No token meter.<br />Your machine,<br />your limits.</h2></div><div><p>Run an open-weight coding model through a loopback-compatible server. Atlas keeps the provider contract neutral, so local inference can remain the default while hosted fallbacks stay optional.</p><ul><li>Open-weight model served locally</li><li>No per-token API charge</li><li>Repository data stays on your network</li><li>Hardware and electricity are the real cost</li></ul></div></section>
    <footer><span>ATLAS / 2026</span><span>LOCAL-FIRST · POLICY-ENFORCED · AUDITABLE</span></footer>
  </main>;
}
