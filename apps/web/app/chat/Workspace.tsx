"use client";
import { useEffect, useRef } from "react";
import { DiffLines, MessageBody } from "./MessageBody.js";

/**
 * What Atlas is doing, the way a coding agent shows it: a tree of the agents
 * working on a reply (lead → team → child agents) with the tools each one is
 * using, and a closable side panel with a terminal-style log of every step
 * and a Files view of everything Atlas read or changed.
 */

export type ToolStep = { id: string; label: string; state: "running" | "done" | "failed"; agentId?: string };
export type AgentNode = { id: string; parentId: string | null; name: string; role?: string; title: string; state: string; depth: number; summary?: string };
export type LogLine = { id: string; at: number; kind: "agent" | "tool" | "run" | "note"; state?: string; who?: string; text: string };
export type FilePage = { offset: number; end: number; totalChars: number; nextOffset: number | null; fileSha: string | null };
export type Preview = { kind: "file" | "page"; title: string; content: string; url?: string; repository?: string; path?: string; page?: FilePage };
export type WorkItem =
  | { id: string; kind: "file"; title: string; path: string; repository?: string; content: string; page?: FilePage }
  | { id: string; kind: "page"; title: string; url: string; content: string }
  | { id: string; kind: "diff"; title: string; path: string; status: string; additions: number; deletions: number; patch: string | null; truncated: boolean; pullRequestUrl?: string | null };

/** Keep each read range and revision distinct; rereading the same page refreshes it. */
export function itemFromPreview(preview: Preview): WorkItem {
  if (preview.kind === "page") return { id: `page:${preview.url}`, kind: "page", title: preview.title, url: preview.url ?? "", content: preview.content };
  const page = preview.page;
  const partial = page && (page.offset > 0 || page.end < page.totalChars);
  const title = preview.path ?? preview.title;
  return { id: `file:${preview.repository}/${preview.path}${page ? `:${page.fileSha}:${page.offset}:${page.end}` : ""}`, kind: "file", title: partial ? `${title} · ${page.offset}–${page.end}` : title, path: title, repository: preview.repository, content: preview.content, page };
}

const STEP_MARK: Record<ToolStep["state"], string> = { running: "●", done: "✓", failed: "✕" };
const AGENT_MARK: Record<string, string> = { planning: "◌", running: "●", verifying: "◎", done: "✓", unverified: "!", failed: "✕", skipped: "–" };
const AGENT_STATE: Record<string, string> = { planning: "planning", running: "working", verifying: "checking its work", done: "verified", unverified: "unverified", failed: "failed", skipped: "skipped" };

/** Tool steps, optionally folded into "N steps". */
export function ToolSteps({ steps, collapsed = false }: { readonly steps: ToolStep[]; readonly collapsed?: boolean }) {
  const list = <ol className="activity-steps tool-steps">
    {steps.map((step) => <li key={step.id} className={step.state}><span aria-hidden="true">{STEP_MARK[step.state]}</span>{step.label}</li>)}
  </ol>;
  if (!collapsed) return list;
  return <details className="thinking-block"><summary>{steps.length === 1 ? "1 step" : `${steps.length} steps`}</summary>{list}</details>;
}

/** The agent family working on a reply, each agent with its own tool steps. */
export function AgentTree({ agents, steps, collapsed = false }: { readonly agents: AgentNode[]; readonly steps: ToolStep[]; readonly collapsed?: boolean }) {
  if (!agents.length) return null;
  const children = (parentId: string | null) => agents.filter((agent) => agent.parentId === parentId);
  const render = (agent: AgentNode) => {
    const own = steps.filter((step) => step.agentId === agent.id);
    const kids = children(agent.id);
    return <li key={agent.id} className={`agent-node agent-${agent.state}`}>
      <div className="agent-line">
        <span className="agent-mark" aria-hidden="true">{AGENT_MARK[agent.state] ?? "●"}</span>
        <strong>{agent.name}</strong>
        <span className="agent-title">{agent.title}</span>
        <small>{AGENT_STATE[agent.state] ?? agent.state}{agent.summary && agent.depth === 0 ? ` · ${agent.summary}` : ""}</small>
      </div>
      {own.length > 0 && <ol className="agent-tools">{own.map((step) => <li key={step.id} className={step.state}><span aria-hidden="true">{STEP_MARK[step.state]}</span>{step.label}</li>)}</ol>}
      {kids.length > 0 && <ul className="agent-children">{kids.map(render)}</ul>}
    </li>;
  };
  const tree = <ul className="agent-tree">{children(null).map(render)}</ul>;
  if (!collapsed) return tree;
  const count = agents.filter((agent) => agent.depth > 0).length;
  return <details className="thinking-block"><summary>Agent team · {count} agent{count === 1 ? "" : "s"}</summary>{tree}</details>;
}

function time(at: number) {
  return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/** The closable side panel: a terminal-style log and the files Atlas touched. */
export function WorkPanel({ tab, onTab, onClose, log, items, selectedId, onSelect }: {
  readonly tab: "terminal" | "files"; readonly onTab: (tab: "terminal" | "files") => void; readonly onClose: () => void;
  readonly log: LogLine[]; readonly items: WorkItem[]; readonly selectedId: string | null; readonly onSelect: (id: string) => void;
}) {
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (tab === "terminal") endRef.current?.scrollIntoView({ block: "end" }); }, [log.length, tab]);
  const selected = items.find((item) => item.id === selectedId) ?? items[0] ?? null;
  const changed = items.filter((item) => item.kind === "diff");
  const read = items.filter((item) => item.kind !== "diff");
  return <aside className="atlas-side-panel" aria-label="Atlas work panel">
    <div className="atlas-side-panel-bar">
      <div role="tablist" aria-label="Panel views">
        <button role="tab" aria-selected={tab === "terminal"} className={tab === "terminal" ? "active" : ""} onClick={() => onTab("terminal")}>Terminal</button>
        <button role="tab" aria-selected={tab === "files"} className={tab === "files" ? "active" : ""} onClick={() => onTab("files")}>Files{items.length ? ` · ${items.length}` : ""}</button>
      </div>
      <button className="atlas-side-panel-close" aria-label="Close panel" onClick={onClose}>×</button>
    </div>
    {tab === "terminal" ? <div className="terminal" role="log" aria-live="polite">
      {log.length === 0 && <p className="terminal-empty">$ waiting for Atlas… every agent, tool and run step appears here as it happens.</p>}
      {log.map((line) => <div key={line.id} className={`terminal-line term-${line.kind} ${line.state ? `term-${line.state}` : ""}`}>
        <span className="term-time">{time(line.at)}</span>
        {line.who && <span className="term-who">{line.who}</span>}
        <span className="term-text">{line.text}</span>
      </div>)}
      <div ref={endRef} />
    </div> : <div className="files-view">
      <div className="files-list" role="navigation" aria-label="Files">
        {items.length === 0 && <p className="terminal-empty">Files Atlas reads or changes show up here.</p>}
        {changed.length > 0 && <p className="files-group">Changed</p>}
        {changed.map((item) => <FileEntry key={item.id} item={item} active={item.id === selected?.id} onSelect={onSelect} />)}
        {read.length > 0 && <p className="files-group">Read</p>}
        {read.map((item) => <FileEntry key={item.id} item={item} active={item.id === selected?.id} onSelect={onSelect} />)}
      </div>
      {selected && <div className="file-preview"><FilePreview item={selected} /></div>}
    </div>}
  </aside>;
}

function FileEntry({ item, active, onSelect }: { readonly item: WorkItem; readonly active: boolean; readonly onSelect: (id: string) => void }) {
  return <button className={active ? "file-entry active" : "file-entry"} onClick={() => onSelect(item.id)} title={item.title}>
    <span className={`file-kind kind-${item.kind === "diff" ? item.status : item.kind}`}>{item.kind === "diff" ? item.status[0].toUpperCase() : item.kind === "page" ? "↗" : "▤"}</span>
    <span className="file-name">{item.title}</span>
    {item.kind === "diff" && <small><b className="plus">+{item.additions}</b> <b className="minus">−{item.deletions}</b></small>}
  </button>;
}

/** Markdown renders as a document; code gets line numbers; diffs get colour; pages show their text. */
export function FilePreview({ item }: { readonly item: WorkItem }) {
  if (item.kind === "diff") {
    return <div>
      <p className="preview-head"><strong>{item.path}</strong> <small>{item.status}{item.pullRequestUrl ? <> · <a href={item.pullRequestUrl} target="_blank" rel="noreferrer">pull request ↗</a></> : null}</small></p>
      {item.patch ? <pre className="md-code diff-view"><code><DiffLines patch={item.patch} /></code></pre> : <p className="terminal-empty">No text diff (binary or too large).</p>}
      {item.truncated && <p className="terminal-empty">Diff shortened; open the pull request for the rest.</p>}
    </div>;
  }
  if (item.kind === "page") {
    return <div><p className="preview-head"><strong>{item.title}</strong> <small><a href={item.url} target="_blank" rel="noreferrer noopener">{item.url} ↗</a></small></p><MessageBody text={item.content} /></div>;
  }
  const markdown = /\.(md|mdx|markdown)$/iu.test(item.path);
  const partial = item.page && (item.page.offset > 0 || item.page.end < item.page.totalChars);
  return <div>
    <p className="preview-head"><strong>{item.path}</strong>{item.repository ? <small> · {item.repository}</small> : null}</p>
    {partial && <p className="terminal-empty">Partial file · offsets {item.page!.offset}–{item.page!.end} of {item.page!.totalChars} (UTF-16). Other ranges are not shown here.</p>}
    {partial ? <pre className="md-code"><code>{item.content}</code></pre> : markdown ? <MessageBody text={item.content} /> : <pre className="md-code code-view"><code>{item.content.split("\n").map((line, i) => <span key={i} className="code-line"><span className="line-no">{i + 1}</span>{line || " "}{"\n"}</span>)}</code></pre>}
  </div>;
}
