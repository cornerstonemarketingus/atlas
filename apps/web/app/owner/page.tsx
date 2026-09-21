import type { Metadata } from "next";
import { MarketingFooter, MarketingNav } from "../MarketingNav.js";
import { OwnerAccess } from "./OwnerAccess.js";

export const metadata: Metadata = {
  title: "Owner access — Atlas",
  description: "Secure owner sign-in for an unrestricted private Atlas workspace.",
};

export default function OwnerPage() {
  return <main><MarketingNav /><section className="owner-access"><div><p className="eyebrow"><span>PRIVATE ACCESS</span> Atlas owner workspace</p><h1>Your unrestricted<br /><em>operator seat.</em></h1><p>Sign in with the approved GitHub identity for passwordless owner access, or use the private deployment code. Owner access unlocks coding and computer-operation modes without plan limits.</p><ul><li>GitHub verifies your identity; Atlas never receives your GitHub password.</li><li>The operator credential stays server-side and out of browser storage.</li><li>Consequential computer actions still require one-action approval.</li></ul></div><OwnerAccess /></section><MarketingFooter /></main>;
}
