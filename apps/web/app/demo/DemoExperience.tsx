"use client";
import { useState } from "react";

const stages = [
  ["Understands the mission", "Mapped the product, repository boundaries, and release requirements."],
  ["Plans bounded work", "Selected the smallest reversible change set with explicit success criteria."],
  ["Builds in isolation", "Created an isolated workspace. Your main branch and live computer remain untouched."],
  ["Verifies the result", "Runs the repository's own build and tests, and separates new failures from ones that were already there."],
  ["Requests your decision", "One consequential action is ready. The approval applies only to this exact change."],
];

export function DemoExperience() {
  const [step, setStep] = useState(0);
  const [decision, setDecision] = useState<"approved" | "denied" | null>(null);
  const active = Math.min(step, stages.length - 1);
  function advance() { setDecision(null); setStep((value) => (value + 1) % stages.length); }
  const evidence = ["42 files mapped · 8 product surfaces", "4 edits · reversible · no schema change", "workspace/atlas-demo-4821", "build ✓  tests 705/705 ✓  policy ✓", "publish.preview · exact digest bound"][active];
  return <section className="demo-stage" aria-label="Interactive Atlas product demonstration">
    <div className="demo-sidebar"><span className="demo-live"><i /> SCRIPTED WALKTHROUGH · ILLUSTRATIVE FIGURES</span><h2>Launch a polished customer onboarding flow</h2><p>A worked example of one mission, start to finish. The figures below illustrate the shape of a real run; they are not from one.</p><ol>{stages.map(([label], index) => <li key={label} className={index < active ? "done" : index === active ? "active" : ""}><i />{label}</li>)}</ol></div>
    <div className="demo-workspace"><div className="demo-windowbar"><span /><span /><span /><b>atlas://mission/onboarding</b></div><div className="demo-message user"><small>YOU</small><p>Make onboarding feel premium, explain our value in under a minute, and prove it works before release.</p></div><div className="demo-message atlas"><small>ATLAS</small><h3>{stages[active][0]}</h3><p>{stages[active][1]}</p><div className="evidence"><span>Example evidence</span><code>{evidence}</code></div></div>
      {active === stages.length - 1 && <div className="demo-approval"><div><small>YOUR APPROVAL</small><b>Publish the verified preview?</b><p>Nothing is sent, bought, or published here. This button only advances the walkthrough.</p></div>{decision ? <strong>{decision === "approved" ? "Approved once ✓" : "Declined safely"}</strong> : <div><button onClick={() => setDecision("denied")}>Decline</button><button onClick={() => setDecision("approved")}>Approve once</button></div>}</div>}
      <button className="demo-next" onClick={advance}>{active === stages.length - 1 ? "Replay mission" : "Show next step"} <span>→</span></button></div>
  </section>;
}
