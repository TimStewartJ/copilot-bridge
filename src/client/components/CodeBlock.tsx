import { useState, useCallback, type ReactElement } from "react";
import { Copy, Check } from "lucide-react";

/** Extract plain text from React children (recursive) */
function extractText(node: unknown): string {
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (!node) return "";
  if (Array.isArray(node)) return node.map(extractText).join("");
  if (typeof node === "object" && "props" in (node as ReactElement)) {
    const el = node as ReactElement;
    return extractText(el.props.children);
  }
  return "";
}

/** Detect language label from <code className="language-xxx"> */
function detectLanguage(children: unknown): string | null {
  if (
    children &&
    typeof children === "object" &&
    "props" in (children as ReactElement)
  ) {
    const className = (children as ReactElement).props.className as
      | string
      | undefined;
    const match = className?.match(/language-(\S+)/);
    return match ? match[1] : null;
  }
  return null;
}

interface CodeBlockProps {
  children?: React.ReactNode;
  node?: unknown;
  [key: string]: unknown;
}

export default function CodeBlock({ children, node: _node, ...rest }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    const text = extractText(children);
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [children]);

  const language = detectLanguage(children);

  return (
    <div className="not-prose relative group my-2">
      <button
        onClick={handleCopy}
        className="absolute top-2 right-2 p-1.5 rounded-md bg-bg-surface/80 backdrop-blur-sm border border-border
          text-text-muted hover:text-text-primary opacity-0 group-hover:opacity-100 transition-all z-10"
        aria-label={copied ? "Copied" : "Copy code"}
      >
        {copied ? <Check size={14} className="text-green-400" /> : <Copy size={14} />}
      </button>
      <pre
        {...rest}
        className="rounded-md bg-bg-primary p-3 text-xs overflow-x-auto max-w-full border border-border"
      >
        {children}
      </pre>
    </div>
  );
}
