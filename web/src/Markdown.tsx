import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import Mermaid from "./Mermaid";

// The one non-standard rendering rule: a fenced ```mermaid block becomes a diagram instead of a
// code block. Everything else (tables, headers, lists, bold, blockquotes, links, inline/fenced
// code) is plain GFM markdown — no custom syntax to maintain beyond this.
export default function Markdown({ text, renderMermaid = true }: { text: string; renderMermaid?: boolean }) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ node, ...props }) => <a {...props} target="_blank" rel="noreferrer" />,
          table: ({ node, ...props }) => (
            <div className="table-scroll">
              <table {...props} />
            </div>
          ),
          code({ className, children }) {
            const lang = /language-(\w+)/.exec(className ?? "")?.[1];
            const codeText = String(children).replace(/\n$/, "");
            // react-markdown v9 dropped the `inline` prop, and a fenced block with no language
            // tag gets no className either — indistinguishable from inline code by className
            // alone. A real inline code *span* can never contain a literal newline (CommonMark
            // terminates it at line end), so multi-line content is always a block even without
            // a language tag — falling through to the langless-inline branch otherwise rendered
            // each wrapped line as its own background box (an inline element's background
            // renders per visual line when it wraps).
            if (!className && !codeText.includes("\n")) return <code className="inline-code">{children}</code>;
            if (lang === "mermaid" && renderMermaid) return <Mermaid code={codeText} />;
            return (
              <pre className="codeblock">
                <code>{codeText}</code>
              </pre>
            );
          },
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
