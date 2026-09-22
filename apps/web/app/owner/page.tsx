import type { Metadata } from "next";
import { MarketingFooter, MarketingNav } from "../MarketingNav.js";
import { OwnerAccess } from "./OwnerAccess.js";

export const metadata: Metadata = {
  title: "Owner access — Atlas",
  description: "Secure owner sign-in for a private Atlas operator workspace.",
};

export default function OwnerPage() {
  return <main><MarketingNav /><section className="owner-access"><div><p className="eyebrow"><span>PRIVATE ACCESS</span> Atlas owner workspace</p><h1>Your private<br /><em>operator seat.</em></h1><p>Sign in with the approved GitHub identity for passwordless owner access, or use the private deployment code. The owner seat removes subscription limits while keeping Atlas policy, approval, audit, and verification safeguards active.</p><ul><li>GitHub verifies your identity; Atlas never receives your GitHub password.</li><li>A subscription—even a paid plan—never grants deployment-owner authority.</li><li>Self-modification is restricted to the owner and still travels through isolated changes, tests, and review.</li><li>Consequential computer actions require exact, one-action approval.</li></ul><p><a href="/guide">Read the login, controls, and safety guide →</a></p></div><OwnerAccess /></section><MarketingFooter /></main>;
}
