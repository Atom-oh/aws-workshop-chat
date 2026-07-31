import type { ReactNode } from "react";

// Slack-style minimal markdown: fenced ```code blocks``` and `inline code`, nothing else — no
// bold/italic/links, since messages are plain participant text, not authored content.
export function renderBody(text: string): ReactNode[] {
  const parts: ReactNode[] = [];
  const codeBlockRe = /```[^\S\n]*\w*\n?([\s\S]*?)```/g;
  let last = 0;
  let match: RegExpExecArray | null;
  let key = 0;
  while ((match = codeBlockRe.exec(text))) {
    if (match.index > last) parts.push(...renderInline(text.slice(last, match.index), key++));
    parts.push(
      <pre className="codeblock" key={`cb-${key++}`}>
        <code>{match[1].replace(/\n$/, "")}</code>
      </pre>,
    );
    last = match.index + match[0].length;
  }
  if (last < text.length) parts.push(...renderInline(text.slice(last), key++));
  return parts;
}

function renderInline(text: string, keyBase: number): ReactNode[] {
  const inlineRe = /`([^`\n]+)`/g;
  const nodes: ReactNode[] = [];
  let last = 0;
  let match: RegExpExecArray | null;
  let key = 0;
  while ((match = inlineRe.exec(text))) {
    if (match.index > last) nodes.push(text.slice(last, match.index));
    nodes.push(
      <code className="inline-code" key={`${keyBase}-ic-${key++}`}>
        {match[1]}
      </code>,
    );
    last = match.index + match[0].length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

// Deterministic per-participant avatar color — same idea as Slack's generated-color avatars.
export function avatarColor(id: string): string {
  let hash = 0;
  for (const ch of id) hash = (hash * 31 + ch.charCodeAt(0)) % 360;
  return `hsl(${hash}, 55%, 42%)`;
}
