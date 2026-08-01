import { useEffect, useRef, useState } from "react";
import { COLORS } from "./theme";

// mermaid bundles a renderer per diagram type (flowchart/sequence/gantt/C4/architecture/...) —
// large enough (~1MB before gzip) that it must stay a dynamic import, loaded only the first time
// a message actually contains a ```mermaid block, not part of the app's main bundle.
let mermaidPromise: Promise<typeof import("mermaid").default> | null = null;
function loadMermaid() {
  if (!mermaidPromise) {
    mermaidPromise = import("mermaid").then((m) => {
      m.default.initialize({ startOnLoad: false, theme: "dark", securityLevel: "strict" });
      return m.default;
    });
  }
  return mermaidPromise;
}

let seq = 0;

// Rendering an in-progress (still-streaming) diagram throws a parse error on every keystroke of
// output — callers pass `renderMermaid=false` while streaming (see Markdown.tsx) so this only
// ever runs against a complete code block. A genuine syntax error still falls back to raw text
// rather than showing nothing.
export default function Mermaid({ code }: { code: string }) {
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const id = useRef(`mermaid-${++seq}`);

  useEffect(() => {
    let cancelled = false;
    setSvg(null);
    setError(false);
    loadMermaid()
      .then((mermaid) => mermaid.render(id.current, code))
      .then((r) => { if (!cancelled) setSvg(r.svg); })
      .catch(() => { if (!cancelled) setError(true); });
    return () => { cancelled = true; };
  }, [code]);

  if (error) {
    return (
      <pre className="codeblock">
        <code>{code}</code>
      </pre>
    );
  }
  if (!svg) return <div style={{ padding: 12, fontSize: 12, color: COLORS.dim }}>다이어그램 렌더링 중…</div>;
  return (
    <div
      style={{ margin: "8px 0", background: COLORS.bgDark, border: `1px solid ${COLORS.border}`, borderRadius: 8, padding: 12, overflowX: "auto" }}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
