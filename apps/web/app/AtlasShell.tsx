"use client";
import Link from "next/link";
import { ReactNode, useEffect, useState } from "react";
import { AtlasMark } from "./AtlasMark.js";

/**
 * The one navigation every signed-in surface uses.
 *
 * Before this existed each signed-in page carried its own chrome — the
 * workspace had a sidebar, /computer had a marketing header that called home
 * "Workspace", /setup called the same destination "Back to tasks", and
 * /account was a bare legal page. Four pages, four vocabularies, no way to see
 * what else Atlas could do from where you happened to be standing. The rail
 * below is deliberately always present and always identical: chat, then the
 * modes Atlas works in (Create, Operate), then the places you configure it.
 */

export type Section = "chat" | "build" | "automation" | "connections" | "settings";

type NavItem = { id: Section; href: string; label: string; glyph: string; hint?: string };

export const PRIMARY_SECTIONS: readonly NavItem[] = [
  { id: "chat", href: "/", label: "Chat", hint: "Ask, plan, decide", glyph: "◇" },
  { id: "build", href: "/build", label: "Create", hint: "Build and improve software", glyph: "⬢" },
  { id: "automation", href: "/automation", label: "Operate", hint: "Work on your computer", glyph: "◈" },
];

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

  const current = [...PRIMARY_SECTIONS, ...UTILITY_SECTIONS].find((item) => item.id === section);

  return <div className={`atlas-shell ${wide ? "shell-wide" : ""}`}>
    {menuOpen && <button className="shell-scrim" aria-label="Close navigation" onClick={() => setMenuOpen(false)} />}
    <aside className={`shell-rail ${menuOpen ? "open" : ""}`}>
      <div className="rail-top">
        <Link className="workspace-brand" href="/"><span><AtlasMark /></span>ATLAS</Link>
        <button className="rail-close" aria-label="Close navigation" onClick={() => setMenuOpen(false)}>×</button>
      </div>
      <nav className="rail-sections" aria-label="Atlas sections">
        {PRIMARY_SECTIONS.map((item) => (
          <Link key={item.id} href={item.href} aria-current={item.id === section ? "page" : undefined}
            className={item.id === section ? "rail-link active" : "rail-link"} onClick={() => setMenuOpen(false)}>
            <span className="rail-glyph" aria-hidden="true">{item.glyph}</span>
            <span className="rail-text"><b>{item.label}</b>{item.hint && <small>{item.hint}</small>}</span>
          </Link>
        ))}
      </nav>
      {rail}
      <div className="rail-bottom">
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
          <span className="shell-where"><span className="privacy-dot" />{current?.label ?? "Atlas"}</span>
        </div>
        <div className="shell-header-context">{headerContext}</div>
      </header>
      {children}
    </section>
  </div>;
}
