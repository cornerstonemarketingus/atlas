import type { Metadata } from "next";
import Link from "next/link";
import { MarketingFooter, MarketingNav } from "../MarketingNav.js";
import { DemoExperience } from "./DemoExperience.js";
export const metadata: Metadata = { title: "Autonomous vibe-coding demo — Atlas", description: "A scripted walkthrough of how Atlas turns a product idea into planned, built, verified, approval-bound work." };
export default function DemoPage() { return <main><MarketingNav /><section className="marketing-hero compact"><p className="eyebrow"><span>DEMO</span> From vibe to verified product</p><h1>Don’t watch another<br /><em>AI magic trick.</em></h1><p>A scripted walkthrough of one mission — design intent, real implementation, validation, and a release decision you have to approve. It illustrates how Atlas works; it is not a live run against your code.</p></section><DemoExperience /><section className="closing-cta"><p>Ready to move beyond the prototype?</p><h2>Describe the product.<br />Atlas carries the mission.</h2><Link href="/api/auth/github/start">Start free with GitHub →</Link></section><MarketingFooter /></main>; }
