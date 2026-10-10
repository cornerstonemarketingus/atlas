import type { Metadata } from "next";
import Link from "next/link";
import { MarketingFooter, MarketingNav } from "../MarketingNav.js";

export const metadata: Metadata = {
  title: "About — Atlas",
  description: "Atlas combines autonomous app creation, computer control and persistent agents, building toward complete business launch and continuous SEO/GEO growth.",
};

export default function AboutPage() {
  return <main>
    <MarketingNav />
    <section className="marketing-hero compact">
      <p className="eyebrow"><span>ABOUT</span> Build it. Run it. Grow it.</p>
      <h1>From an idea<br /><em>to a working business.</em></h1>
      <p>Atlas is an autonomous AI workspace built to turn goals into software and repeatable digital work. It brings website and app creation, verified coding, computer control and persistent automation into one system.</p>
    </section>
    <section className="about-body">
      <div>
        <h2>The opportunity</h2>
        <p>Starting and growing a business means coordinating software, a website, customer workflows and daily operations. Atlas is building toward one continuous mission: plan, build, verify, launch, operate and improve.</p>
        <p>The software foundations work today. The broader goal is complete business launch and growth, with full applications, ongoing search engine optimization (SEO), generative engine optimization (GEO) and measurable operational feedback.</p>
        <h2>What works today</h2>
        <ul>
          <li>Build supported business websites, dashboards, CRUD apps and REST APIs, then run checks, inspect previews and repair failures.</li>
          <li>Publish repositories and deploy static websites through approved integrations. Hosting server-backed apps remains additional work.</li>
          <li>Coordinate parallel agents and turn recurring work into scheduled and event-driven automations.</li>
          <li>Operate browser and computer tasks on a paired Windows PC, with revocable remote access over a customer-managed HTTPS or VPN connection.</li>
          <li>Use local models and customer-owned credentials, with optional hosted providers and visible policies, budgets and evidence.</li>
        </ul>
      </div>
      <div>
        <h2>A system that can grow</h2>
        <p>Atlas connects agents, tools, memory and explicit world state through a shared runtime. Verified outcomes can inform future model choices, while successful workflows can become persistent automations.</p>
        <p>The next capability loop will identify missing tools, build and independently test them, then install approved skills for future missions. Guarded self-improvement already exists; the complete loop is still being connected.</p>
        <h2>What comes next</h2>
        <p>Continuous SEO/GEO optimization, server-backed app deployment, complete business operations, richer visual editing and cloud execution are development goals. Current website templates provide SEO foundations; they do not establish growth or ranking outcomes.</p>
        <p>Quantum physics is a founder-identified research direction. Its implementation and experimental results are not documented on public main, so Atlas does not yet claim a validated quantum capability.</p>
        <h2>Who builds Atlas</h2>
        <p>Atlas is built by Anthony Hahn, an independent founder based in Minnesota. The product is built around customer ownership, verified execution and autonomy governed by policy and approvals.</p>
        <p>Questions and ideas go to the <a href="https://github.com/cornerstonemarketingus/atlas/issues">Atlas issue tracker</a>. The <a href="https://github.com/cornerstonemarketingus/atlas/blob/main/TODO.md">public roadmap</a> separates implemented capabilities from remaining work.</p>
        <p><Link href="/">Try Atlas free →</Link></p>
      </div>
    </section>
    <MarketingFooter />
  </main>;
}
