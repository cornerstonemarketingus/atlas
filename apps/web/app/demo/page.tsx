import type { Metadata } from "next";
import Link from "next/link";
import { MarketingFooter, MarketingNav } from "../MarketingNav.js";
import { DemoExperience } from "./DemoExperience.js";
export const metadata: Metadata = { title: "Interactive demo — Atlas", description: "See how Atlas plans, builds, verifies, and asks before consequential actions." };
export default function DemoPage() { return <main><MarketingNav /><section className="marketing-hero compact"><p className="eyebrow"><span>DEMO</span> From request to evidence</p><h1>Don’t watch another<br /><em>AI magic trick.</em></h1><p>Walk through the control loop that makes Atlas useful: persistent context, bounded execution, visible evidence, and approvals that mean exactly one thing.</p></section><DemoExperience /><section className="closing-cta"><p>Ready for the real thing?</p><h2>Give Atlas a mission.<br />Keep the final say.</h2><Link href="/api/auth/github/start">Start free with GitHub →</Link></section><MarketingFooter /></main>; }
