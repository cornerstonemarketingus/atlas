import type { Metadata } from "next";
import { MarketingFooter, MarketingNav } from "../MarketingNav.js";
import { OwnerAccess } from "./OwnerAccess.js";

export const metadata: Metadata = {
  title: "Owner sign-in — Atlas",
  description: "Sign in as the owner of this Atlas deployment.",
};

export default function OwnerPage() {
  return <main><MarketingNav /><section className="owner-access"><div><p className="eyebrow"><span>OWNER</span> For the person who runs this deployment</p><h1>Owner<br /><em>sign-in.</em></h1><p>Sign in with the GitHub account set as owner, or with the owner access code. The owner has no plan limits, and still gets approval requests for important actions.</p><ul><li>GitHub checks your identity. Atlas never sees your GitHub password.</li><li>Buying a plan never makes someone an owner.</li><li>Only the owner can have Atlas work on Atlas&rsquo;s own code.</li><li>Important computer actions still need a one-time approval.</li></ul><p><a href="/guide">How Atlas keeps you in control →</a></p></div><OwnerAccess /></section><MarketingFooter /></main>;
}
