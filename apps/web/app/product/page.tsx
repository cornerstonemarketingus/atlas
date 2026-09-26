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
  title: "Product — Atlas",
  description: "Atlas answers questions, changes code in your GitHub projects through pull requests, and does browser tasks on your computer, asking before anything important.",
};

const capabilities = [
  ["Chat", "Ask anything. Conversations are saved and available on every device you sign in from."],
  ["Code changes", "Ask for a fix or a feature. Atlas edits a branch of your repository, runs your tests, and opens a pull request."],
  ["Project reviews", "Ask Atlas to look through a project and report what to improve, or to find why a test is failing."],
  ["Browser tasks", "Research, forms, listings and portals, done in a separate browser profile on your Windows PC."],
  ["Your choice of model", "Use a hosted model or one running on your own machine (Ollama, LM Studio, vLLM and others)."],
  ["Approvals", "Atlas stops and asks before it sends, submits, buys, publishes, uploads, or changes an account."],
];

export default function ProductPage() {
  return <main>
    <MarketingNav />
    <section className="marketing-hero">
      <p className="eyebrow"><span>PRODUCT</span> What Atlas does</p>
      <h1>One assistant for code<br /><em>and browser work.</em></h1>
      <p>Atlas is a chat assistant that can also do the work you ask for. It changes code in your GitHub projects through pull requests, and it handles browser tasks on your computer. It shows you what it did, and asks before anything important.</p>
      <div className="hero-actions"><Link href="/">Start free</Link><Link href="/demo" className="quiet">See how it works</Link></div>
    </section>

    <section className="capability-grid">
      {capabilities.map(([title, copy], index) => <article key={title}><span>0{index + 1}</span><h2>{title}</h2><p>{copy}</p></article>)}
    </section>

    <ParallelMissionPreview />

    <section className="proof-section">
      <div>
        <p className="eyebrow"><span>WHAT YOU GET BACK</span> Proof, not promises</p>
        <h2>Every task ends with something you can check.</h2>
      </div>
      <div>
        <article><b>Code</b><p>A pull request with the diff and the test results. If nothing needed to change, Atlas says so.</p></article>
        <article><b>Browser tasks</b><p>An activity log of each step, and an approval request before anything that can&rsquo;t be undone.</p></article>
        <article><b>Merging</b><p>Per project, you choose: merge after you review, merge automatically once all tests pass, or merge right away.</p></article>
        <article><b>Your data</b><p>Your repositories and credentials stay in your own accounts. Remove Atlas&rsquo;s access at any time.</p></article>
      </div>
    </section>

    <section className="closing-cta">
      <p>Free to start. No card needed.</p>
      <h2>Tell Atlas what you need.</h2>
      <Link href="/">Start free →</Link>
    </section>
    <MarketingFooter />
  </main>;
}
