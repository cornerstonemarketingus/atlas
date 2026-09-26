import type { Metadata } from "next";
import Link from "next/link";
import { MarketingFooter, MarketingNav } from "../MarketingNav.js";
import { ParallelMissionPreview } from "./ParallelMissionPreview.js";

/**
 * Copy rule for this page: headlines describe what Atlas is for; every mode
 * then says plainly what is available today, what runs in the self-hosted
 * control plane, and what is still being built. Nothing unbuilt is written in
 * the present tense, and there are no claims about other products — only what
 * is architecturally different about Atlas.
 */
export const metadata: Metadata = {
  title: "Atlas — Build it. Run it. Grow it.",
  description: "Atlas is an autonomous AI workspace that builds software, operates computers and turns successful work into persistent automations.",
};

type Availability = { now: string[]; selfHosted?: string[]; next?: string[] };

const MODES: { id: string; kicker: string; title: string; copy: string; availability: Availability }[] = [
  {
    id: "create",
    kicker: "CREATE",
    title: "Go from an idea to working software.",
    copy: "Describe an application, feature, API, automation or business tool. Atlas assembles an AI engineering team to design it, build the full stack, test the real product and prepare it for launch.",
    availability: {
      now: ["Changes to your existing repository, verified against its own build and tests, returned as a pull request you review", "Planning and architecture help in chat, streamed as it is written"],
      next: ["New projects from a single description, with editable requirements and plans", "Live preview and visual editing mapped to the real source"],
    },
  },
  {
    id: "operate",
    kicker: "OPERATE",
    title: "Give AI the tools to actually do the work.",
    copy: "Atlas agents can work through authorized browsers, computers, terminals, files and connected services.",
    availability: {
      now: ["A paired Windows computer that Atlas operates in the browser and in desktop applications", "Live step-by-step progress, local screenshots as evidence, and an approval before every consequential action"],
      selfHosted: ["Browser, desktop, terminal and file tools for local agents, governed by your own allow / ask / deny policy"],
    },
  },
  {
    id: "automate",
    kicker: "AUTOMATE",
    title: "Turn work into an autonomous system.",
    copy: "Take successful work and turn it into scheduled, event-driven or monitored missions.",
    availability: {
      now: ["Tasks survive a closed tab or a disconnected computer and resume where they stopped"],
      selfHosted: ["Durable multi-agent missions with checkpoints, budgets and crash recovery"],
      next: ["Schedules, webhooks and monitoring triggers that start saved missions"],
    },
  },
];

const PILLARS = [
  { kicker: "AUTONOMOUS DEVELOPMENT", title: "Your repository doesn’t stop improving when you stop prompting.", copy: "Authorize Atlas to inspect your project for bugs, regressions and valuable improvements. Atlas builds changes in isolation, tests them, repairs failures and presents verified improvements for approval.", note: "Runs daily on the Atlas repository today, with a person merging every change. Its Business Development and Product executives propose only evidence-backed work in the self-hosted control plane." },
  { kicker: "COMPUTER", title: "Software that can use software.", copy: "Browser. Desktop. Terminal. Files. APIs. One set of rules decides what runs, what waits for you, and what never happens.", note: "Browser and desktop control ship in the Windows companion; terminal and file tools run in the self-hosted control plane." },
  { kicker: "AGENTS", title: "Don’t hire one AI. Assemble a team.", copy: "Engineering. Design. QA. Security. Operations. Research. Business. Each agent has a role, a budget and only the permissions its parent could give it — and business agents decide what is worth building before engineering builds it.", note: "The agent organization runs in the self-hosted control plane." },
  { kicker: "ADVANCED", title: "Full control when you want it.", copy: "Inspect code, diffs, terminal activity, models, permissions, budgets and every consequential action.", note: "Every task keeps an activity receipt; approvals are bound to the exact action and expire." },
];

function AvailabilityList({ availability }: { availability: Availability }) {
  return <dl className="availability">
    <div><dt>Available now</dt>{availability.now.map((item) => <dd key={item}>{item}</dd>)}</div>
    {availability.selfHosted && <div><dt>Self-hosted control plane</dt>{availability.selfHosted.map((item) => <dd key={item}>{item}</dd>)}</div>}
    {availability.next && <div><dt>In progress</dt>{availability.next.map((item) => <dd key={item}>{item}</dd>)}</div>}
  </dl>;
}

export default function ProductPage() {
  return <main>
    <MarketingNav />
    <section className="marketing-hero">
      <p className="eyebrow"><span>ATLAS</span> An autonomous AI workspace</p>
      <h1>Build it. Run it.<br /><em>Grow it.</em></h1>
      <p>Atlas is an autonomous AI workspace that builds software, operates computers and turns successful work into persistent automations.</p>
      <div className="hero-actions"><Link href="/api/auth/github/start">Start building</Link><Link href="/demo" className="quiet">Walk through a mission</Link></div>
    </section>

    <section className="category-section">
      <p className="eyebrow"><span>GO BEYOND THE CODING ASSISTANT</span> Coding is only one part of building a product</p>
      <div>
        <article><b>One workspace for the whole job.</b><p>Atlas combines AI software development, visual building, computer operation, autonomous agents, deployment and persistent automation in one workspace.</p></article>
        <article><b>It reports what actually happened.</b><p>Every task links its run, its evidence and its pull request. When nothing changed, Atlas says exactly that instead of reporting success.</p></article>
        <article><b>It stops before it acts on your behalf.</b><p>Sends, submissions, purchases, uploads, publishing and account changes pause for a one-time approval bound to that exact action.</p></article>
      </div>
    </section>

    {MODES.map((mode) => <section className="mode-section" id={mode.id} key={mode.id}>
      <div>
        <p className="eyebrow"><span>{mode.kicker}</span></p>
        <h2>{mode.title}</h2>
        <p>{mode.copy}</p>
      </div>
      <AvailabilityList availability={mode.availability} />
    </section>)}

    <ParallelMissionPreview />

    <section className="capability-grid pillars">
      {PILLARS.map((pillar, index) => <article key={pillar.kicker}><span>0{index + 1} · {pillar.kicker}</span><h2>{pillar.title}</h2><p>{pillar.copy}</p><p className="pillar-note">{pillar.note}</p></article>)}
    </section>

    <section className="proof-section">
      <div>
        <p className="eyebrow"><span>THE DIFFERENCE</span> Autonomy you can inspect</p>
        <h2>Atlas does not ask you to trust a magic box. It shows the work — and admits when there is none.</h2>
      </div>
      <div>
        <article><b>Evidence, not assurances</b><p>Tests, screenshots, pull requests and activity receipts — Atlas reports what it can observe and nothing beyond it.</p></article>
        <article><b>Consequential-action control</b><p>Approvals are bound to the exact action, expire, and can be answered from your phone.</p></article>
        <article><b>Review before merge</b><p>Code changes always arrive as a pull request. Whether one may merge itself is a per-project setting that defaults to a person.</p></article>
        <article><b>Portable by construction</b><p>Point Atlas at any OpenAI-compatible model — local or hosted. The provider is configuration, not architecture.</p></article>
      </div>
    </section>

    <section className="closing-cta">
      <p>Create. Operate. Automate.</p>
      <h2>Give Atlas the outcome.<br />Keep control of the mission.</h2>
      <Link href="/guide">See how access and safeguards work →</Link>
    </section>
    <MarketingFooter />
  </main>;
}
