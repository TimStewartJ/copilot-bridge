import { useState, useCallback, useEffect, useRef, type ComponentPropsWithoutRef, type ReactNode } from "react";
import { AlertTriangle, Copy, Check } from "lucide-react";
import { writeClipboardText } from "../lib/clipboard";

type CopyState = "idle" | "copied" | "failed";

const COPY_LABELS: Record<CopyState, string> = {
  idle: "Copy code",
  copied: "Copied",
  failed: "Copy failed",
};

const DIFF_LANGUAGES = new Set(["diff", "patch", "udiff"]);

type ElementProps = {
  children?: unknown;
  className?: unknown;
};

function getElementProps(node: unknown): ElementProps | null {
  if (!node || typeof node !== "object" || !("props" in node)) return null;
  const props = (node as { props?: unknown }).props;
  return props && typeof props === "object" ? props : null;
}

/** Extract plain text from React children (recursive) */
function extractText(node: unknown): string {
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (!node) return "";
  if (Array.isArray(node)) return node.map(extractText).join("");
  const props = getElementProps(node);
  if (props) return extractText(props.children);
  return "";
}

/** Detect language label from <code className="language-xxx"> */
function detectLanguage(children: unknown): string | null {
  const props = getElementProps(children);
  if (props && typeof props.className === "string") {
    const match = props.className.match(/language-(\S+)/);
    return match ? match[1] : null;
  }
  return null;
}

function isDiffLanguage(language: string | null): boolean {
  return Boolean(language && DIFF_LANGUAGES.has(language.toLowerCase()));
}

function looksLikeUnifiedDiff(text: string): boolean {
  const lines = text.split(/\r?\n/);
  if (lines.some((line) => line.startsWith("diff --git "))) return true;

  const hasHunk = lines.some((line) => line.startsWith("@@ "));
  if (!hasHunk) return false;

  const hasAddition = lines.some((line) => line.startsWith("+") && !line.startsWith("+++"));
  const hasDeletion = lines.some((line) => line.startsWith("-") && !line.startsWith("---"));
  return hasAddition && hasDeletion;
}

function trimSingleTrailingNewline(text: string): string {
  return text.replace(/\r?\n$/, "");
}

function getDiffLineClass(line: string): string {
  if (line.startsWith("@@ ")) {
    return "border-accent/40 bg-accent-surface text-accent";
  }
  if (
    line.startsWith("diff --git ")
    || line.startsWith("index ")
    || line.startsWith("new file mode ")
    || line.startsWith("deleted file mode ")
    || line.startsWith("similarity index ")
    || line.startsWith("rename from ")
    || line.startsWith("rename to ")
    || line.startsWith("--- ")
    || line.startsWith("+++ ")
  ) {
    return "border-text-faint/40 bg-bg-secondary text-text-muted";
  }
  if (line.startsWith("+")) {
    return "border-success/50 bg-success/10 text-success";
  }
  if (line.startsWith("-")) {
    return "border-error/50 bg-error/10 text-error";
  }
  return "border-transparent text-text-secondary";
}

function DiffBlock({ text, rest }: { text: string; rest: ComponentPropsWithoutRef<"pre"> }) {
  const lines = trimSingleTrailingNewline(text).split(/\r?\n/);
  return (
    <pre
      {...rest}
      className="rounded-md bg-bg-primary py-2 text-xs overflow-x-auto max-w-full border border-border"
    >
      {lines.map((line, index) => (
        <span
          key={index}
          className={`block min-w-max border-l-2 px-3 py-0.5 ${getDiffLineClass(line)}`}
        >
          {line || " "}
        </span>
      ))}
    </pre>
  );
}

interface CodeBlockProps extends ComponentPropsWithoutRef<"pre"> {
  children?: ReactNode;
  node?: unknown;
}

export default function CodeBlock({ children, node: _node, ...rest }: CodeBlockProps) {
  const [copyState, setCopyState] = useState<CopyState>("idle");
  const copyResetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copyRequestRef = useRef(0);

  useEffect(() => () => {
    copyRequestRef.current += 1;
    if (copyResetTimerRef.current) clearTimeout(copyResetTimerRef.current);
    copyResetTimerRef.current = null;
  }, []);

  const handleCopy = useCallback(() => {
    const text = extractText(children);
    const requestId = copyRequestRef.current + 1;
    copyRequestRef.current = requestId;
    if (copyResetTimerRef.current) clearTimeout(copyResetTimerRef.current);
    copyResetTimerRef.current = null;
    setCopyState("idle");

    const settle = (next: CopyState) => {
      if (copyRequestRef.current !== requestId) return;
      setCopyState(next);
      copyResetTimerRef.current = setTimeout(() => {
        copyResetTimerRef.current = null;
        if (copyRequestRef.current !== requestId) return;
        setCopyState("idle");
      }, 2000);
    };

    void writeClipboardText(text).then(() => settle("copied"), () => settle("failed"));
  }, [children]);

  const language = detectLanguage(children);
  const text = extractText(children);
  const renderDiff = isDiffLanguage(language) || (!language && looksLikeUnifiedDiff(text));

  return (
    <div className="not-prose relative group my-2">
      <button
        onClick={handleCopy}
        className="code-copy-button absolute top-2 right-2 inline-flex items-center justify-center p-2 rounded-md
          bg-bg-surface/90 backdrop-blur-sm border border-border
          text-text-muted hover:text-text-primary transition-all z-10"
        aria-label={COPY_LABELS[copyState]}
        title={copyState === "failed" ? "Copy failed — clipboard unavailable" : undefined}
      >
        {copyState === "copied" && <Check size={14} className="text-copy-success" />}
        {copyState === "failed" && <AlertTriangle size={14} className="text-error" />}
        {copyState === "idle" && <Copy size={14} />}
      </button>
      {renderDiff ? (
        <DiffBlock text={text} rest={rest} />
      ) : (
        <pre
          {...rest}
          className="rounded-md bg-bg-primary p-3 text-xs overflow-x-auto max-w-full border border-border"
        >
          {children}
        </pre>
      )}
    </div>
  );
}
