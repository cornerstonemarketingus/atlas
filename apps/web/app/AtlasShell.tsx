"use client";
import Link from "next/link";
import { ReactNode, useEffect, useState } from "react";
import { AtlasMark } from "./AtlasMark.js";

/**
 * The one navigation every signed-in surface uses.
 *
 * Atlas does not ask people to choose how it should work before they have
 * said what they want. The rail is therefore just New chat and History (the
 * thread list a page passes in as `rail`). Code, Computer and the other
 * capabilities are not destinations here: Atlas invokes them from inside a
 * conversation, and the conversation shows them as context when they are in
 * use. Their pages still exist for reopening that work, reached from there.
 *
 * Before this existed each signed-in page carried its own chrome — the
 * workspace had a sidebar, /computer had a marketing header that called home
 * "Workspace", /setup called the same destination "Back to tasks", and
 * /account was a bare legal page. Four pages, four vocabularies, no way to see
 * what else Atlas could do from where you happened to be standing. The rail
 * is always present and always identical. What only exists on the local
 * daemon (missions, agent families, knowledge, approvals) is one link to the
 * local console rather than imitated here.
 */

export type Section = "chat" | "build" | "automation" | "connections" | "settings";

type NavItem = { id: Section; href: string; label: string; glyph: string; hint?: string };

/** Where each section sits when it is shown in the header, not the rail. */
const SECTION_LABELS: Record<Section, string> = {
  chat: "Atlas",
  build: "Code",
  automation: "Computer control",
  connections: "Connections",
  settings: "Settings",
};

/** Sections served by Atlas on the owner's computer (the local daemon's console). */
export const LOCAL_CONSOLE = "http://127.0.0.1:4317";

const UTILITY_SECTIONS: readonly NavItem[] = [
  { id: "connections", href: "/setup", label: "Connections", glyph: "⟐" },
  { id: "settings", href: "/account", label: "Settings", glyph: "⚙" },
];

type ShellProps = {
  readonly section: Section;
  /** Rendered under the section list — the thread list, for the sections that have one. */
  readonly rail?: ReactNode;
  /** Right-hand side of the header bar: context chips, panel toggles. */
  readonly headerContext?: ReactNode;
  readonly children: ReactNode;
  /** Set by the workspace when its right-hand work panel is open. */
  readonly wide?: boolean;
};

export function AtlasShell({ section, rail, headerContext, children, wide = false }: ShellProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [account, setAccount] = useState<{ signedIn: boolean; githubLogin?: string | null } | null>(null);

  useEffect(() => {
    let active = true;
    void fetch("/api/account")
      .then((response) => (response.ok ? response.json() : null))
      .then((value) => { if (active && value) setAccount(value as { signedIn: boolean; githubLogin?: string | null }); })
      .catch(() => undefined);
    return () => { active = false; };
  }, []);

  // Route changes are full navigations here, but the drawer is also closed on
  // every click inside it so a mis-tap never leaves it covering the page.
  async function signOut() {
    try { await fetch("/api/auth/logout", { method: "POST" }); } catch { /* the redirect below still lands on the sign-in gate */ }
    window.location.href = "/";
  }


  return <div className={`atlas-shell ${wide ? "shell-wide" : ""}`}>
    {menuOpen && <button className="shell-scrim" aria-label="Close navigation" onClick={() => setMenuOpen(false)} />}
    <aside className={`shell-rail ${menuOpen ? "open" : ""}`}>
      <div className="rail-top">
        <Link className="workspace-brand" href="/"><span><AtlasMark /></span>ATLAS</Link>
        <button className="rail-close" aria-label="Close navigation" onClick={() => setMenuOpen(false)}>×</button>
      </div>
      {rail ?? <nav className="rail-sections" aria-label="Atlas">
        <Link className="new-thread" href="/" onClick={() => setMenuOpen(false)}><b>＋</b> New chat</Link>
        <Link className="rail-utility" href="/" onClick={() => setMenuOpen(false)}><span aria-hidden="true">◷</span>History</Link>
      </nav>}
      <div className="rail-bottom">
        <a className="rail-utility" href={LOCAL_CONSOLE} target="_blank" rel="noopener noreferrer" title="Opens when the Atlas app is running on this computer">
          <span aria-hidden="true">↗</span>Atlas on this computer
        </a>
        {UTILITY_SECTIONS.map((item) => (
          <Link key={item.id} href={item.href} aria-current={item.id === section ? "page" : undefined}
            className={item.id === section ? "rail-utility active" : "rail-utility"} onClick={() => setMenuOpen(false)}>
            <span aria-hidden="true">{item.glyph}</span>{item.label}
          </Link>
        ))}
        <button className="rail-utility" onClick={() => void signOut()}>
          <span aria-hidden="true">↩</span>Sign out{account?.githubLogin ? ` · ${account.githubLogin}` : ""}
        </button>
      </div>
    </aside>
    <section className="shell-body">
      <header className="shell-header">
        <div className="header-leading">
          <button className="shell-menu" aria-label="Open navigation" onClick={() => setMenuOpen(true)}>☰</button>
          <span className="shell-where"><span className="privacy-dot" />{SECTION_LABELS[section]}</span>
        </div>
        <div className="shell-header-context">{headerContext}</div>
      </header>
      {children}
    </section>
  </div>;
}
