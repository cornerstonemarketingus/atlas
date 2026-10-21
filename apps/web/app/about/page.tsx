import type { Metadata } from "next";
import Link from "next/link";
import { MarketingFooter, MarketingNav } from "../MarketingNav.js";

export const metadata: Metadata = {
  title: "About — Atlas",
  description: "Atlas is an autonomous software platform with child agents, app creation and computer control, building toward complete business creation.",
};

export default function AboutPage() {
  return <main>
    <MarketingNav />
    <section className="marketing-hero compact">
      <p className="eyebrow"><span>ABOUT</span> Build it. Run it. Grow it.</p>
      <h1>Give it a goal.<br /><em>Build what comes next.</em></h1>
      <p>Atlas is an autonomous software platform built to turn ideas into working products—and working products into businesses. It brings repositories, websites, apps, agents, tools and computer control together in one system.</p>
    </section>
    <section className="about-body">
      <div>
        <h2>Why Atlas exists</h2>
        <p>Building something means connecting an idea to code, tests, deployment, customer workflows and daily operations. Atlas is built around one continuous mission: create, execute, operate and grow.</p>
        <p>Software creation is the foundation. Autonomous business creation is the larger ambition: launch a product, connect the workflows around it, and keep improving it. Games and other digital products expand that creation vision.</p>
        <h2>Create and execute</h2>
        <ul>
          <li><strong>Repositories, websites and apps:</strong> Project Genesis builds supported business sites, dashboards, CRUD apps and REST APIs, with generated backend modules and conversational change requests.</li>
          <li><strong>Verify and repair:</strong> baseline-aware checks, bounded repairs, live previews, desktop/phone browser inspection and optional vision review.</li>
          <li><strong>Child agents and specialist teams:</strong> mission children divide work into scoped tasks; parallel coder lanes use isolated worktrees and return evidence for comparison.</li>
          <li><strong>A shared agent kernel:</strong> goals, mounted capabilities and explicit world state connect chat, team steps, coder lanes and Genesis builds.</li>
          <li><strong>World and impact graphs:</strong> repository relationships connect files, packages, imports and tests so Atlas can trace what a change could affect.</li>
        </ul>
        <h2>Operate over time</h2>
        <ul>
          <li><strong>Persistent missions:</strong> saved progress, recovery state, event streams and a Command Center with mission/lane controls and traces.</li>
          <li><strong>Sleeping goals and automations:</strong> bounded goals wake on GitHub events; schedules, webhooks and file changes start recurring work.</li>
          <li><strong>Remote computer control:</strong> paired Windows browser/computer execution and revocable phone access over customer-managed HTTPS or VPN.</li>
          <li><strong>Scoped memory and MCP tools:</strong> retain context and evidence provenance while connecting allowed external tools to the runtime.</li>
        </ul>
      </div>
      <div>
        <h2>Intelligence that can grow</h2>
        <p>Atlas supports customer-owned local models and optional hosted providers. Capability economics uses verified local mission history to inform model selection; inference controls govern quota and recovery. Adaptive autonomy assesses action risk and tightens owner policy.</p>
        <p>Guarded self-improvement combines isolated changes, checks and independent review. Agent families and the innovation pipeline organize business, product, research, engineering, design and oversight work around evidence-backed decisions.</p>
        <p>The next capability loop will detect a missing tool, build and independently verify it, then install an approved skill for future missions. The foundations exist; the complete installation loop and broader adversarial-review tiers are still being connected.</p>
        <h2>From idea to operation</h2>
        <p>The opportunity is an execution layer between an idea and an operating business. The roadmap joins product development, deployment, customer workflows, ongoing SEO and generative engine optimization (GEO), analytics and recurring operations.</p>
        <p>Supported website/app/API creation and SEO foundations are implemented. Dedicated game creation, complete autonomous business operation, continuous SEO/GEO growth, richer visual editing and persistent cloud execution remain development goals. Local and hosted surfaces have different capability coverage.</p>
        <h2>Advanced research</h2>
        <p>Quantum physics is a founder-identified research direction. Its implementation and experimental results are not documented on public main; a validated quantum capability remains unverified.</p>
        <h2>Who builds Atlas</h2>
        <p>Atlas is built by Anthony Hahn, an independent founder based in Minnesota. The product is built around customer ownership, verified execution and autonomy governed by policy, budgets and approvals.</p>
        <p>Questions and ideas go to the <a href="https://github.com/cornerstonemarketingus/atlas/issues">Atlas issue tracker</a>. The <a href="https://github.com/cornerstonemarketingus/atlas/blob/main/TODO.md">public roadmap</a> records implemented slices and remaining work.</p>
        <p><Link href="/">Try Atlas free →</Link></p>
      </div>
    </section>
    <MarketingFooter />
  </main>;
}
