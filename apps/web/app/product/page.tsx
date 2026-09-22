import type { Metadata } from "next";
import Link from "next/link";
import { MarketingFooter, MarketingNav } from "../MarketingNav.js";
import { ParallelMissionPreview } from "./ParallelMissionPreview.js";

/**
 * Copy rule for this page: present tense describes what the hosted workspace
 * does when you sign in today. The mission runtime — child agents, budgets,
 * checkpoints, recovery — runs in the self-hosted control plane, so it is
 * named as that rather than implied to be part of the product you just bought.
 * Anything not built yet is written as not built yet.
 */
export const metadata: Metadata = {
  title: "Atlas — Build the product. Operate the work.",
  description: "Describe an outcome. Atlas opens a reviewable pull request, or tells you plainly that it did not — and pauses before any consequential computer action.",
};

const capabilities = [
  ["Describe the outcome", "Say what you want in plain language. Atlas turns it into a bounded job against a real repository and branch you choose."],
  ["Engineer against the real codebase", "Atlas reads the project, edits on its own branch, runs the repository's builds and tests, and opens a pull request you review before anything merges."],
  ["Operate the browser", "Research, fill forms, navigate portals, and complete repeatable browser work on a Windows computer you pair — or a hosted browser on paid plans."],
  ["Keep the thread", "Conversations, the jobs started from them, and their results persist across sessions and devices instead of vanishing with the tab."],
  ["Run on your own model", "Point Atlas at any OpenAI-compatible server — Ollama, llama.cpp, vLLM, LM Studio — or a hosted one. The provider is configuration, not architecture."],
  ["Stop before it costs you", "Sends, submissions, purchases, uploads, publishing, and account changes pause for a one-time approval bound to that exact action."],
];

export default function ProductPage() {
  return <main>
    <MarketingNav />
    <section className="marketing-hero">
      <p className="eyebrow"><span>ATLAS</span> An operator that builds software and works a browser</p>
      <h1>Build the product.<br /><em>Operate the work.</em></h1>
      <p>Describe the outcome once. Atlas works against your real repository on its own branch, runs the project&rsquo;s own checks, and opens a pull request for you to review — then carries the browser work around the launch, pausing before anything with a consequence. You keep the approvals, the credentials, and the receipts.</p>
      <div className="hero-actions"><Link href="/demo">Walk through a mission</Link><Link href="/api/auth/github/start" className="quiet">Start building</Link></div>
    </section>

    <section className="category-section">
      <p className="eyebrow"><span>ONE SYSTEM</span> Beyond the point solutions</p>
      <div>
        <article><b>It does not stop at the first screen.</b><p>Atlas works in the repository you already have — architecture, tests, and a pull request against your branch — rather than generating a project you then have to adopt.</p></article>
        <article><b>It reports what actually happened.</b><p>Every job links its run and its pull request. When a run finishes without changing anything, Atlas says exactly that instead of reporting success.</p></article>
        <article><b>It stops before it acts on your behalf.</b><p>Browser work pauses at a one-action approval bound to the specific step, with an activity receipt you can read afterwards.</p></article>
      </div>
    </section>

    <ParallelMissionPreview />

    <section className="capability-grid">
      {capabilities.map(([title, copy], index) => <article key={title}><span>0{index + 1}</span><h2>{title}</h2><p>{copy}</p></article>)}
    </section>

    <section className="proof-section">
      <div>
        <p className="eyebrow"><span>THE ADVANTAGE</span> Autonomy you can inspect</p>
        <h2>Atlas does not ask you to trust a magic box. It shows the work — and admits when there is none.</h2>
      </div>
      <div>
        <article><b>Evidence, not assurances</b><p>A job shows the state of its run and links the log and the pull request. Atlas reports what it can observe and nothing beyond it.</p></article>
        <article><b>Consequential-action control</b><p>Sending, submitting, publishing, purchasing, uploading, and account changes pause at an exact approval boundary that expires.</p></article>
        <article><b>Review before merge</b><p>Build mode always opens a pull request. Whether it may then merge itself is a per-project setting that defaults to a person doing it.</p></article>
        <article><b>Portable by construction</b><p>Run the models locally and keep the repository and credentials yours. Hosted capacity is an adapter you can remove.</p></article>
      </div>
    </section>

    <section className="closing-cta">
      <p>Still being built: step-by-step progress from inside a run, and findings reported back into the thread rather than left in the run log.</p>
      <h2>Give Atlas the outcome.<br />Keep control of the mission.</h2>
      <Link href="/guide">See how access and safeguards work →</Link>
    </section>
    <MarketingFooter />
  </main>;
}
