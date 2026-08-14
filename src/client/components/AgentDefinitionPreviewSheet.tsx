import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { Bot, FileText, X } from "lucide-react";
import {
  fetchTaskAgentDefinition,
  type TaskAgentDefinition,
  type TaskAgentDefinitionSummary,
} from "../api";
import CodeBlock from "./CodeBlock";
import { APP_PROSE } from "./shared/prose-classes";
import { LoadingSkeletonRegion, Skeleton, SkeletonText } from "./shared/Skeleton";
import { useModalDialog } from "./shared/useModalDialog";
import { UI } from "./shared/design-system";

interface AgentDefinitionPreviewSheetProps {
  taskId: string;
  definition: TaskAgentDefinitionSummary;
  onClose: () => void;
}

function toolsLabel(tools: string[] | null): string {
  if (tools === null) return "All tools";
  if (tools.length === 0) return "No tools";
  return `${tools.length} tool${tools.length === 1 ? "" : "s"}`;
}

export default function AgentDefinitionPreviewSheet({
  taskId,
  definition,
  onClose,
}: AgentDefinitionPreviewSheetProps) {
  const [detail, setDetail] = useState<TaskAgentDefinition | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { titleId, dialogProps } = useModalDialog({ onDismiss: onClose });

  useEffect(() => {
    let cancelled = false;
    setDetail(null);
    setError(null);
    fetchTaskAgentDefinition(taskId, definition.name)
      .then((result) => {
        if (!cancelled) setDetail(result);
      })
      .catch((reason) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => {
      cancelled = true;
    };
  }, [definition.name, taskId]);

  return (
    <div className="fixed inset-0 z-50 flex items-end md:items-start md:justify-center">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div
        {...dialogProps}
        className="relative flex max-h-[88vh] w-full flex-col rounded-t-2xl border border-border bg-bg-primary shadow-2xl md:mt-12 md:mb-12 md:max-h-[84vh] md:max-w-2xl md:rounded-xl"
      >
        <div className="flex shrink-0 items-center justify-between border-b border-border px-5 py-3">
          <h2 id={titleId} className="flex min-w-0 items-center gap-2 text-sm font-medium text-text-primary">
            <Bot size={15} className="shrink-0 text-agent" />
            <span className="truncate">{definition.displayName ?? definition.name}</span>
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="text-text-muted transition-colors hover:text-text-secondary"
            aria-label="Close agent definition preview"
          >
            <X size={16} />
          </button>
        </div>

        <div className="shrink-0 border-b border-border/50 px-5 py-3">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className={`rounded-full px-1.5 py-0.5 text-[11px] font-medium ${UI.chip.muted}`}>
              {definition.name}
            </span>
            <span className={`rounded-full px-1.5 py-0.5 text-[11px] font-medium ${definition.infer ? UI.chip.info : UI.chip.muted}`}>
              {definition.infer ? "Auto + explicit" : "Explicit only"}
            </span>
            <span className={`rounded-full px-1.5 py-0.5 text-[11px] font-medium ${UI.chip.muted}`}>
              {toolsLabel(definition.tools)}
            </span>
          </div>
          <p className="mt-2 text-sm text-text-secondary">{definition.description}</p>
          <div className="mt-2 flex items-center gap-1.5 text-[10px] font-mono text-text-faint">
            <FileText size={11} />
            {definition.fileName}
          </div>
        </div>

        <div className="flex-1 space-y-6 overflow-y-auto px-5 py-4">
          {!detail && !error && (
            <LoadingSkeletonRegion isLoading label="Loading agent definition preview" className="space-y-4">
              <SkeletonText lines={5} widths="paragraph" />
              <Skeleton height={140} width="100%" shape="rounded" />
            </LoadingSkeletonRegion>
          )}
          {error && <div className="rounded-md bg-error/10 px-3 py-2 text-sm text-error">{error}</div>}
          {detail && (
            <>
              <section>
                <h3 className="mb-2 text-[11px] font-medium uppercase tracking-wide text-text-faint">
                  Agent instructions
                </h3>
                <div className={`max-w-none rounded-lg bg-bg-surface px-4 py-3 ${APP_PROSE}`}>
                  <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]} components={{ pre: CodeBlock }}>
                    {detail.prompt}
                  </ReactMarkdown>
                </div>
              </section>
              <section>
                <h3 className="mb-2 text-[11px] font-medium uppercase tracking-wide text-text-faint">
                  Raw profile
                </h3>
                <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-lg border border-border bg-bg-secondary px-4 py-3 text-xs text-text-secondary">
                  {detail.raw}
                </pre>
              </section>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
