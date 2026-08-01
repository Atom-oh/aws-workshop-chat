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
            // alone. LLM output reliably tags fences with a language, so this is a non-issue in
            // practice; a stray langless fence would render as an inline chip instead of a block.
            if (!className) return <code className="inline-code">{children}</code>;
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
