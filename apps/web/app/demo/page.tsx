import type { Metadata } from "next";
import Link from "next/link";
import { MarketingFooter, MarketingNav } from "../MarketingNav.js";
import { DemoExperience } from "./DemoExperience.js";
export const metadata: Metadata = { title: "Autonomous vibe-coding demo — Atlas", description: "See Atlas turn a product idea into planned, built, verified, approval-bound work." };
export default function DemoPage() { return <main><MarketingNav /><section className="marketing-hero compact"><p className="eyebrow"><span>DEMO</span> From vibe to verified product</p><h1>Don’t watch another<br /><em>AI magic trick.</em></h1><p>Walk through a product mission that crosses design intent, real implementation, validation, and a consequential release decision—with evidence at every step.</p></section><DemoExperience /><section className="closing-cta"><p>Ready to move beyond the prototype?</p><h2>Describe the product.<br />Atlas carries the mission.</h2><Link href="/api/auth/github/start">Start free with GitHub →</Link></section><MarketingFooter /></main>; }
