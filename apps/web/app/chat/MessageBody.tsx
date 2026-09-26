"use client";
import { useState, type ReactNode } from "react";

/**
 * Renders Markdown from Atlas's replies and from files it reads: paragraphs,
 * headings, bullet and numbered lists, tables, blockquotes, rules, fenced
 * code (with a language label, a copy button, and coloured lines for diffs),
 * inline code, bold, italics and links — as React elements. Never as HTML:
 * the text is untrusted, so nothing in it can become markup, and links are
 * limited to http(s) and paths on this site.
 */
export function MessageBody({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  const lines = text.replace(/\r\n/gu, "\n").split("\n");
  let index = 0;
  let key = 0;
  while (index < lines.length) {
    const line = lines[index];
    const fence = /^\s*(```|~~~)\s*([\w+#.-]*)\s*$/u.exec(line);
    if (fence) {
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !new RegExp(`^\\s*${fence[1]}\\s*$`, "u").test(lines[index])) code.push(lines[index++]);
      index += 1;
      blocks.push(<CodeBlock key={key++} language={fence[2]} code={code.join("\n")} />);
      continue;
    }
    const heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/u.exec(line);
    if (heading) {
      const level = Math.min(heading[1].length, 4);
      blocks.push(<p className={`md-heading md-h${level}`} key={key++} role="heading" aria-level={level + 1}>{inline(heading[2])}</p>);
      index += 1;
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/u.test(line)) {
      blocks.push(<hr className="md-rule" key={key++} />);
      index += 1;
      continue;
    }
    if (/^\s*>/u.test(line)) {
      const quoted: string[] = [];
      while (index < lines.length && /^\s*>/u.test(lines[index])) quoted.push(lines[index++].replace(/^\s*>\s?/u, ""));
      blocks.push(<blockquote className="md-quote" key={key++}><MessageBody text={quoted.join("\n")} /></blockquote>);
      continue;
    }
    if (isTableStart(lines, index)) {
      const header = cells(lines[index]);
      const align = cells(lines[index + 1]).map((cell) => (/^:-+:$/u.test(cell) ? "center" : /-+:$/u.test(cell) ? "right" : "left"));
      index += 2;
      const rows: string[][] = [];
      while (index < lines.length && lines[index].includes("|") && lines[index].trim()) rows.push(cells(lines[index++]));
      blocks.push(<div className="md-table-wrap" key={key++}><table className="md-table">
        <thead><tr>{header.map((cell, i) => <th key={i} style={{ textAlign: align[i] as "left" }}>{inline(cell)}</th>)}</tr></thead>
        <tbody>{rows.map((row, r) => <tr key={r}>{header.map((_, i) => <td key={i} style={{ textAlign: align[i] as "left" }}>{inline(row[i] ?? "")}</td>)}</tr>)}</tbody>
      </table></div>);
      continue;
    }
    if (/^\s*[-*•+]\s+/u.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^\s*[-*•+]\s+/u.test(lines[index])) items.push(lines[index++].replace(/^\s*[-*•+]\s+/u, ""));
      blocks.push(<ul className="md-list" key={key++}>{items.map((item, i) => <li key={i}>{task(item)}</li>)}</ul>);
      continue;
    }
    if (/^\s*\d+[.)]\s+/u.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^\s*\d+[.)]\s+/u.test(lines[index])) items.push(lines[index++].replace(/^\s*\d+[.)]\s+/u, ""));
      blocks.push(<ol className="md-list" key={key++}>{items.map((item, i) => <li key={i}>{inline(item)}</li>)}</ol>);
      continue;
    }
    if (!line.trim()) { index += 1; continue; }
    const paragraph: string[] = [];
    while (index < lines.length && lines[index].trim() && !/^(\s*```|\s*~~~|#{1,6}\s|\s*[-*•+]\s+|\s*\d+[.)]\s+|\s*>)/u.test(lines[index]) && !isTableStart(lines, index)) paragraph.push(lines[index++]);
    blocks.push(<p key={key++}>{inline(paragraph.join("\n"))}</p>);
  }
  return <div className="md-body">{blocks}</div>;
}

function isTableStart(lines: string[], index: number) {
  return lines[index]?.includes("|") && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/u.test(lines[index + 1] ?? "");
}

function cells(row: string) {
  return row.trim().replace(/^\|/u, "").replace(/\|$/u, "").split("|").map((cell) => cell.trim());
}

/** "- [x] done" / "- [ ] todo" render as checkboxes. */
function task(item: string): ReactNode {
  const checkbox = /^\[([ xX])\]\s+(.*)$/u.exec(item);
  if (!checkbox) return inline(item);
  return <><span className={checkbox[1] === " " ? "md-check" : "md-check checked"} aria-label={checkbox[1] === " " ? "not done" : "done"}>{checkbox[1] === " " ? "☐" : "☑"}</span> {inline(checkbox[2])}</>;
}

/** A fenced block: language label, copy button, and +/- colouring for diffs. */
export function CodeBlock({ language, code }: { language?: string; code: string }) {
  const [copied, setCopied] = useState(false);
  const isDiff = language === "diff" || language === "patch";
  async function copy() {
    try { await navigator.clipboard.writeText(code); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* clipboard unavailable */ }
  }
  return <div className="md-code-wrap">
    <div className="md-code-bar"><span>{language || "text"}</span><button type="button" onClick={() => void copy()}>{copied ? "Copied" : "Copy"}</button></div>
    <pre className="md-code" data-language={language || undefined}><code>{isDiff ? <DiffLines patch={code} /> : code}</code></pre>
  </div>;
}

/** Unified-diff lines with additions, removals and hunk headers marked. */
export function DiffLines({ patch }: { patch: string }) {
  return <>{patch.split("\n").map((line, i) => {
    const kind = line.startsWith("@@") ? "hunk" : line.startsWith("+") && !line.startsWith("+++") ? "add" : line.startsWith("-") && !line.startsWith("---") ? "del" : "ctx";
    return <span key={i} className={`diff-line diff-${kind}`}>{line || " "}{"\n"}</span>;
  })}</>;
}

// Links: absolute http(s), or a path on this site ("/automation") — never another scheme.
const INLINE = /(`[^`\n]+`|\*\*[^*\n]+\*\*|(?<![\w*])\*[^*\s][^*\n]*\*(?![\w*])|(?<!\w)_[^_\s][^_\n]*_(?!\w)|\[[^\]\n]+\]\((?:https?:\/\/|\/(?!\/))[^\s)]*\))/gu;

function inline(text: string): ReactNode[] {
  return text.split(INLINE).filter(Boolean).map((part, i) => {
    if (part.startsWith("`") && part.endsWith("`")) return <code key={i}>{part.slice(1, -1)}</code>;
    if (part.startsWith("**") && part.endsWith("**")) return <strong key={i}>{part.slice(2, -2)}</strong>;
    if (part.length > 2 && ((part.startsWith("*") && part.endsWith("*")) || (part.startsWith("_") && part.endsWith("_")))) return <em key={i}>{part.slice(1, -1)}</em>;
    const link = /^\[([^\]]+)\]\(((?:https?:\/\/|\/(?!\/))[^\s)]*)\)$/u.exec(part);
    if (link) return link[2].startsWith("/")
      ? <a key={i} href={link[2]}>{link[1]}</a>
      : <a key={i} href={link[2]} target="_blank" rel="noreferrer noopener">{link[1]}</a>;
    return part;
  });
}
