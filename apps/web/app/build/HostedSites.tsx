"use client";
import { useEffect, useState } from "react";
import { readHostedSites, updatedLabel } from "./hosted-sites-client.mjs";
import "./request-history.css";

type Site = { id: string; name: string; status: string; statusLabel: string; updatedAt: string | null; previewHref: string | null };
type Load = { phase: "loading" } | { phase: "ready"; sites: Site[] } | { phase: "error"; message: string };

/**
 * Your websites: every site this workspace built in chat, reachable again
 * without scrolling back to the message that created it. Loads when opened
 * and on Refresh; it never builds or publishes anything.
 */
export function HostedSites() {
  const [open, setOpen] = useState(false);
  const [load, setLoad] = useState<Load>({ phase: "loading" });
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    let active = true;
    readHostedSites({ signal: controller.signal })
      .then((result) => {
        if (!active) return;
        if (result.signedOut) { window.location.href = "/"; return; }
        setLoad({ phase: "ready", sites: result.sites as Site[] });
      })
      .catch(() => { if (active) setLoad({ phase: "error", message: "Your websites could not be loaded. Try again shortly." }); });
    return () => { active = false; controller.abort(); };
  }, [open, refresh]);

  const now = new Date();
  return <details className="request-history hosted-sites" onToggle={(event) => { const next = event.currentTarget.open; if (next) setLoad({ phase: "loading" }); setOpen(next); }}>
    <summary>Your websites</summary>
    {open && <div className="request-history-body">
      <p>Websites Atlas built for you in chat. Open a preview to review it; nothing here publishes a site.</p>
      <button type="button" disabled={load.phase === "loading"} onClick={() => { setLoad({ phase: "loading" }); setRefresh((value) => value + 1); }}>
        {load.phase === "loading" ? "Loading…" : "Refresh websites"}
      </button>
      <div aria-live="polite">
        {load.phase === "loading" && <p role="status">Loading your websites…</p>}
        {load.phase === "error" && <p role="alert">{load.message}</p>}
        {load.phase === "ready" && load.sites.length === 0 && <p role="status">No websites yet. Ask Atlas in chat to build one, and it will be listed here.</p>}
      </div>
      {load.phase === "ready" && load.sites.length > 0 && <ul className="hosted-sites-list" aria-label="Your websites">
        {load.sites.map((site) => {
          const updated = updatedLabel(site.updatedAt, now);
          return <li key={site.id}>
            <article>
              <h3>{site.name}</h3>
              <small><span className={`site-status ${site.status}`}>{site.statusLabel}</span>{updated && <> · <time dateTime={site.updatedAt ?? undefined}>{updated}</time></>}</small>
              <div className="request-history-actions">
                {site.previewHref
                  ? <a href={site.previewHref} target="_blank" rel="noopener noreferrer" aria-label={`Open preview of ${site.name} (opens in a new tab)`}>Open preview ↗</a>
                  : <span className="site-no-preview">No preview yet</span>}
              </div>
            </article>
          </li>;
        })}
      </ul>}
    </div>}
  </details>;
}
