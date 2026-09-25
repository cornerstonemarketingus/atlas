import type { ReactNode } from "react";

/**
 * Renders a chat reply's Markdown subset — paragraphs, headings, bullet and
 * numbered lists, fenced code, inline code, bold and links — as React
 * elements. Never as HTML: a model reply is untrusted text, so nothing in it
 * can become markup, and links are limited to http(s).
 */
export function MessageBody({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  const lines = text.replace(/\r\n/gu, "\n").split("\n");
  let index = 0;
  let key = 0;
  while (index < lines.length) {
    const line = lines[index];
    const fence = /^```\s*([\w+-]*)\s*$/u.exec(line);
    if (fence) {
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !/^```\s*$/u.test(lines[index])) code.push(lines[index++]);
      index += 1;
      blocks.push(<pre className="md-code" key={key++} data-language={fence[1] || undefined}><code>{code.join("\n")}</code></pre>);
      continue;
    }
    const heading = /^(#{1,4})\s+(.*)$/u.exec(line);
    if (heading) {
      blocks.push(<p className="md-heading" key={key++}><strong>{inline(heading[2])}</strong></p>);
      index += 1;
      continue;
    }
    if (/^\s*[-*•]\s+/u.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^\s*[-*•]\s+/u.test(lines[index])) items.push(lines[index++].replace(/^\s*[-*•]\s+/u, ""));
      blocks.push(<ul className="md-list" key={key++}>{items.map((item, i) => <li key={i}>{inline(item)}</li>)}</ul>);
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
    while (index < lines.length && lines[index].trim() && !/^(```|#{1,4}\s|\s*[-*•]\s+|\s*\d+[.)]\s+)/u.test(lines[index])) paragraph.push(lines[index++]);
    blocks.push(<p key={key++}>{inline(paragraph.join("\n"))}</p>);
  }
  return <div className="md-body">{blocks}</div>;
}

const INLINE = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\[[^\]\n]+\]\(https?:\/\/[^\s)]+\))/gu;

function inline(text: string): ReactNode[] {
  return text.split(INLINE).filter(Boolean).map((part, i) => {
    if (part.startsWith("`") && part.endsWith("`")) return <code key={i}>{part.slice(1, -1)}</code>;
    if (part.startsWith("**") && part.endsWith("**")) return <strong key={i}>{part.slice(2, -2)}</strong>;
    const link = /^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/u.exec(part);
    if (link) return <a key={i} href={link[2]} target="_blank" rel="noreferrer noopener">{link[1]}</a>;
    return part;
  });
}
