import type { Metadata } from "next";
import Link from "next/link";
import { MarketingFooter, MarketingNav } from "../MarketingNav.js";

export const metadata: Metadata = {
  title: "Vision — Atlas",
  description: "From idea to operation: Atlas combines autonomous software creation, child agents and computer control, building toward complete business creation.",
};

const pillars = [
  ["Create", "Build repositories, websites, apps and APIs. Expand the creation platform into games and other digital products."],
  ["Execute", "Coordinate child agents and specialist teams that write code, run checks, repair failures and operate computers."],
  ["Operate", "Carry work through persistent missions, remote control, scheduled automations and goals that wake on events."],
  ["Grow", "Connect product iteration, business workflows, SEO/GEO and reusable capabilities to measured outcomes."],
];

const advanced = [
  ["Child agents and parallel teams", "Mission children take scoped tasks, coder lanes work in isolated worktrees, and the Command Center exposes status, competing versions and execution evidence."],
  ["Agent kernel and world state", "A shared goal-driven runtime connects chat, team steps, coding and Genesis. Repository impact graphs relate packages, files, imports and tests."],
  ["Persistent intelligence", "Scoped memory retains evidence provenance. Local mission model selection uses verified history; optional hosted providers add inference capacity and quota controls."],
  ["Controlled autonomy", "Action-risk assessment tightens owner policy. Budgets, approvals, audit records, checks and independent review support guarded execution and self-improvement."],
];

export default function InvestorsPage() {
  return <main>
    <MarketingNav />
    <section className="marketing-hero">
      <p className="eyebrow"><span>VISION</span> Where Atlas is headed</p>
      <h1>From idea<br /><em>to operation.</em></h1>
      <p>Atlas is an autonomous software platform built to turn ideas into working products—and working products into businesses. Repositories, websites, apps, agents and computer control come together in a system that can create, verify and keep working.</p>
      <div className="hero-actions"><Link href="/demo">See how it works</Link><Link className="quiet" href="/product">Product</Link></div>
    </section>
    <section className="investor-statement">
      <p>THE OPPORTUNITY</p>
      <h2>The execution layer between an idea and an operating business.</h2>
      <div>
        <p>From answers to finished work: the value is in carrying a goal through code, tests, deployment and the operations around a product. Businesses still spend time coordinating these steps across people, models and tools.</p>
        <p>Atlas brings that coordination into a persistent platform. Supported software creation, parallel missions, computer control and durable automations form the foundation. Autonomous business creation is the larger opportunity: launch a product, connect customer workflows and keep improving it.</p>
      </div>
    </section>
    <section className="capability-grid">
      {pillars.map(([title, copy], index) => <article key={title}><span>0{index + 1}</span><h2>{title}</h2><p>{copy}</p></article>)}
    </section>
    <section className="proof-section">
      <div><p className="eyebrow"><span>THE PLATFORM</span> Advanced capabilities</p><h2>One goal. A coordinated software team.</h2></div>
      <div>{advanced.map(([title, copy]) => <article key={title}><b>{title}</b><p>{copy}</p></article>)}</div>
    </section>
    <section className="proof-section">
      <div><p className="eyebrow"><span>THE BUSINESS</span> How Atlas grows</p><h2>Build the product. Extend into its daily operation.</h2></div>
      <div>
        <article><b>Entry point</b><p>Independent builders and businesses seeking supported website/app creation, verified repository changes and computer workflows in one place.</p></article>
        <article><b>Expansion</b><p>Recurring operations, customer workflows, team governance and the business launch-and-growth lifecycle. SEO/GEO is part of that growth vision; games broaden the product-creation direction.</p></article>
        <article><b>Commercial model</b><p>Customer-owned compute provides a local foundation. Managed capacity, team controls, packaging and support offer potential commercial expansion.</p></article>
        <article><b>Compounding value</b><p>Reusable workflows, evidence provenance, verified outcome history and approved capabilities can make the next mission more effective. The complete automatic skill-installation loop remains in development.</p></article>
      </div>
    </section>
    <section className="investor-statement">
      <p>BUILDING WITH EVIDENCE</p>
      <h2>Implemented foundations. A larger creation vision.</h2>
      <div>
        <p>Genesis creates supported sites, apps and APIs with checks, previews and browser verification. Local agent teams, the kernel, impact maps, event-driven goals, automations, model hosting and guarded self-improvement are implemented slices; local and hosted capability coverage differs.</p>
        <p>Dedicated game creation, complete autonomous business operation, continuous SEO/GEO optimization, persistent cloud execution and broader independent review remain roadmap work. The public roadmap records the boundaries. Quantum physics is a founder-identified research direction whose public implementation and results still need verification.</p>
      </div>
    </section>
    <section className="closing-cta"><p>Questions about Atlas or investing?</p><h2>Build what comes next.</h2><Link href="/about">About Atlas →</Link></section>
    <MarketingFooter />
  </main>;
}
