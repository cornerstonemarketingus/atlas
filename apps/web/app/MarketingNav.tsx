import Link from "next/link";
import { AtlasMark } from "./AtlasMark.js";

export function MarketingNav() {
  return <header className="marketing-nav">
    <Link className="brand" href="/"><span className="brandmark"><AtlasMark /></span>ATLAS</Link>
    <nav aria-label="Primary navigation"><Link href="/product#create">Create</Link><Link href="/product#operate">Operate</Link><Link href="/product#automate">Automate</Link><Link href="/demo">Walkthrough</Link><Link href="/pricing">Pricing</Link><Link href="/guide">Guide &amp; safety</Link></nav>
    <Link className="nav-cta" href="/">Open Atlas <span>→</span></Link>
  </header>;
}

export function MarketingFooter() {
  return <footer className="marketing-footer">
    <div><b>ATLAS</b><p>Build it. Run it. Grow it. An autonomous AI workspace for software, computer work and the automations that keep it going.</p></div>
    <div><Link href="/product">Product</Link><Link href="/computer">Operate</Link><Link href="/demo">Walkthrough</Link><Link href="/pricing">Pricing</Link><Link href="/guide">Guide &amp; safety</Link><Link href="/investors">Vision</Link><Link href="/owner">Owner access</Link><Link href="/setup">Setup</Link></div>
    <div><Link href="/legal/privacy">Privacy</Link><Link href="/legal/terms">Terms</Link><Link href="/delete-account">Delete account</Link></div>
    <small>Built for ambitious people who want leverage without surrendering control.</small>
  </footer>;
}
