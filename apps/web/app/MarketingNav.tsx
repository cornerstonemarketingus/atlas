import Link from "next/link";
import { AtlasMark } from "./AtlasMark.js";

export function MarketingNav() {
  return <header className="marketing-nav">
    <Link className="brand" href="/"><span className="brandmark"><AtlasMark /></span>ATLAS</Link>
    <nav aria-label="Primary navigation"><Link href="/computer">Computer operator</Link><Link href="/product">Product</Link><Link href="/demo">Live demo</Link><Link href="/pricing">Pricing</Link><Link href="/investors">Vision</Link></nav>
    <Link className="nav-cta" href="/computer">Launch operator <span>→</span></Link>
  </header>;
}

export function MarketingFooter() {
  return <footer className="marketing-footer">
    <div><b>ATLAS</b><p>One private AI operator for software and computer work.</p></div>
    <div><Link href="/computer">Computer operator</Link><Link href="/product">Product</Link><Link href="/demo">Demo</Link><Link href="/pricing">Pricing</Link><Link href="/investors">Vision</Link><Link href="/owner">Owner access</Link><Link href="/setup">Setup</Link></div>
    <div><Link href="/legal/privacy">Privacy</Link><Link href="/legal/terms">Terms</Link><Link href="/delete-account">Delete account</Link></div>
    <small>Built for ambitious people who want leverage without surrendering control.</small>
  </footer>;
}
