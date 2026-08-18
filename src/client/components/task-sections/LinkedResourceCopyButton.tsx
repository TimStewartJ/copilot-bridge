import { useCallback, useEffect, useRef, useState, type MouseEvent } from "react";
import { AlertTriangle, Check, Copy } from "lucide-react";
import { writeClipboardText } from "../../lib/clipboard";

type CopyState = "idle" | "copied" | "failed";

export interface LinkedResourceCopyButtonProps {
  url: string;
  resourceLabel: string;
  iconSize: number;
  className?: string;
}

export default function LinkedResourceCopyButton({
  url,
  resourceLabel,
  iconSize,
  className,
}: LinkedResourceCopyButtonProps) {
  const [copyState, setCopyState] = useState<CopyState>("idle");
  const copyResetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copyRequestRef = useRef(0);

  useEffect(() => () => {
    copyRequestRef.current += 1;
    if (copyResetTimerRef.current) clearTimeout(copyResetTimerRef.current);
  }, []);

  const handleCopy = useCallback((event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();

    const requestId = copyRequestRef.current + 1;
    copyRequestRef.current = requestId;
    if (copyResetTimerRef.current) clearTimeout(copyResetTimerRef.current);
    copyResetTimerRef.current = null;
    setCopyState("idle");

    const settle = (nextState: Exclude<CopyState, "idle">) => {
      if (copyRequestRef.current !== requestId) return;
      setCopyState(nextState);
      copyResetTimerRef.current = setTimeout(() => {
        copyResetTimerRef.current = null;
        if (copyRequestRef.current === requestId) setCopyState("idle");
      }, 2000);
    };

    void writeClipboardText(url).then(
      () => settle("copied"),
      () => settle("failed"),
    );
  }, [url]);

  const label = copyState === "copied"
    ? `Copied ${resourceLabel} URL`
    : copyState === "failed"
      ? `Could not copy ${resourceLabel} URL`
      : `Copy ${resourceLabel} URL`;

  return (
    <button
      type="button"
      onClick={handleCopy}
      title={label}
      aria-label={label}
      data-copy-state={copyState}
      className={`linked-resource-copy-button shrink-0 self-start text-text-muted hover:text-text-primary transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${className ?? ""}`}
    >
      {copyState === "copied" && <Check size={iconSize} className="text-copy-success" />}
      {copyState === "failed" && <AlertTriangle size={iconSize} className="text-error" />}
      {copyState === "idle" && <Copy size={iconSize} />}
    </button>
  );
}
