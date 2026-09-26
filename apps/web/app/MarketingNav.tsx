import Link from "next/link";
import { AtlasMark } from "./AtlasMark.js";

const LINKS = [
  { href: "/product", label: "Product" },
  { href: "/demo", label: "How it works" },
  { href: "/pricing", label: "Pricing" },
  { href: "/guide", label: "Safety" },
  { href: "/about", label: "About" },
];

export function MarketingNav() {
  return <header className="marketing-nav">
    <Link className="brand" href="/"><span className="brandmark"><AtlasMark /></span>ATLAS</Link>
    <nav aria-label="Primary navigation">{LINKS.map((link) => <Link key={link.href} href={link.href}>{link.label}</Link>)}</nav>
    <Link className="nav-cta" href="/">Sign in <span>→</span></Link>
  </header>;
}

export function MarketingFooter() {
  return <footer className="marketing-footer">
    <div><b>ATLAS</b><p>An AI assistant that writes code in your GitHub projects and does browser work on your computer, checking with you before anything important.</p></div>
    <div>{LINKS.map((link) => <Link key={link.href} href={link.href}>{link.label}</Link>)}<Link href="/investors">Vision</Link></div>
    <div><Link href="/setup">Connections</Link><Link href="/owner">Owner sign-in</Link><Link href="/legal/privacy">Privacy</Link><Link href="/legal/terms">Terms</Link><Link href="/delete-account">Delete account</Link></div>
    <small>© {new Date().getFullYear()} Atlas</small>
  </footer>;
}
