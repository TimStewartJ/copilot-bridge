import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import type { SessionModelSwitchConfirmation } from "../api";

export const MODEL_SWITCH_COMPACTION_TITLE = "Compact conversation before switching?";

/** Same wording as the Copilot CLI's model-switch compaction dialog. */
export function formatModelSwitchCompactionMessage({
  targetModelDisplayName,
  currentTokens,
  targetLimit,
}: SessionModelSwitchConfirmation): string {
  return `Your conversation is using ~${currentTokens.toLocaleString()} tokens, which exceeds ${targetModelDisplayName}'s prompt limit of ${targetLimit.toLocaleString()} tokens. Compact the conversation before switching?`;
}

interface ModelSwitchCompactionPromptProps {
  confirmation: SessionModelSwitchConfirmation;
  compacting: boolean;
  error?: string | null;
  onCompact: () => void;
  onKeepCurrentModel: () => void;
}

/**
 * Mirrors the Copilot CLI: when a conversation exceeds the target model's
 * prompt limit, offer to compact and switch or keep the current model.
 */
export default function ModelSwitchCompactionPrompt({
  confirmation,
  compacting,
  error,
  onCompact,
  onKeepCurrentModel,
}: ModelSwitchCompactionPromptProps) {
  const elapsedSeconds = useElapsedSeconds(compacting);

  return (
    <div
      className="w-full max-w-md bg-bg-secondary border border-border rounded-lg shadow-xl p-4 space-y-4"
      onClick={(event) => event.stopPropagation()}
    >
      <div>
        <div className="text-base font-semibold text-text-primary">{MODEL_SWITCH_COMPACTION_TITLE}</div>
        <p className="mt-1 text-sm text-text-muted">{formatModelSwitchCompactionMessage(confirmation)}</p>
      </div>

      {compacting && (
        <div role="status" className="flex items-center gap-2 text-xs text-text-muted">
          <Loader2 size={12} className="animate-spin" />
          Compacting conversation history ({elapsedSeconds}s)
        </div>
      )}

      {error && (
        <div className="rounded-md border border-error/30 bg-error/10 px-3 py-2 text-xs text-error">
          {error}
        </div>
      )}

      <div className="flex justify-end gap-2">
        <button
          type="button"
          className="rounded-md border border-border px-3 py-2 text-sm font-medium text-text-secondary hover:bg-bg-hover disabled:opacity-50"
          onClick={onKeepCurrentModel}
          disabled={compacting}
        >
          Keep current model
        </button>
        <button
          type="button"
          className="rounded-md bg-accent px-3 py-2 text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-50"
          onClick={onCompact}
          disabled={compacting}
        >
          Compact and switch
        </button>
      </div>
    </div>
  );
}

function useElapsedSeconds(active: boolean): number {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    setSeconds(0);
    if (!active) return;
    const timer = setInterval(() => setSeconds((value) => value + 1), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return seconds;
}
