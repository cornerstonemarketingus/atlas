import type { Metadata } from "next";
import Link from "next/link";
import { MarketingFooter, MarketingNav } from "../MarketingNav.js";
import { DemoExperience } from "./DemoExperience.js";
export const metadata: Metadata = { title: "How it works — Atlas", description: "A step-by-step example of Atlas taking a request from chat to a tested pull request and an approved browser task." };
export default function DemoPage() { return <main><MarketingNav /><section className="marketing-hero compact"><p className="eyebrow"><span>HOW IT WORKS</span> One request, start to finish</p><h1>From a request<br /><em>to a finished task.</em></h1><p>Step through an example: what you type, what Atlas does, what it shows you, and where it stops to ask. This is a recorded example, not a live run on your code.</p></section><DemoExperience /><section className="closing-cta"><p>Free to start. No card needed.</p><h2>Try it on your own project.</h2><Link href="/">Start free →</Link></section><MarketingFooter /></main>; }
