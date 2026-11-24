import { useState } from "react";
import { Pencil } from "lucide-react";
import { applyCustomAutopilot } from "../../api";
import { Button, IconButton, StatusIcon } from "../../design/primitives";
import { DS } from "../../design/tokens";
import type { CustomAutopilot, CustomAutopilotProgress } from "../../../shared/send-mode.js";
import CustomAutopilotDialog, { formatMinimums } from "./CustomAutopilotDialog";

interface AutopilotRunLineProps {
  /** A question is open; Autopilot waits for its answer, so the run is not going on its own. */
  waitingForAnswer: boolean;
  minimums?: CustomAutopilot;
  /** When the Custom Autopilot run started, so a time minimum can show when it is reached. */
  progress?: CustomAutopilotProgress;
  /** With both, minimums can be set on this run while it works. */
  sessionId?: string | null;
  runId?: string;
}

/** ", until 6:42 PM" for a time minimum whose start is known. */
function timeMinimumEnd(minimums: CustomAutopilot, progress: CustomAutopilotProgress | undefined): string {
  const startedAt = progress ? Date.parse(progress.startedAt) : NaN;
  if (minimums.minMinutes === undefined || !Number.isFinite(startedAt)) return "";
  const end = new Date(startedAt + minimums.minMinutes * 60_000);
  return `, until ${end.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
}

/** Shown for a whole autopilot run, so it is clear the run will not stop to wait for the user. */
export default function AutopilotRunLine({ waitingForAnswer, minimums, progress, sessionId, runId }: AutopilotRunLineProps) {
  /** The run the open dialog was opened for; a later run never gets its minimums. */
  const [editing, setEditing] = useState<string>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const openEditor = (id: string) => {
    setError(undefined);
    setEditing(id);
  };
  const apply = (mode: CustomAutopilot) => {
    if (!sessionId || !editing) return;
    setPending(true);
    setError(undefined);
    applyCustomAutopilot(sessionId, editing, mode).then(() => setEditing(undefined), (err: unknown) => {
      setError(err instanceof Error ? err.message : "Could not set the minimums.");
    }).finally(() => setPending(false));
  };
  return (
    <div className={`${DS.layout.readingColumn} pb-1`}>
      <div
        className="flex min-w-0 items-center gap-2 px-1 text-xs"
        role="status"
        data-autopilot-run={waitingForAnswer ? "waiting" : "working"}
      >
        {waitingForAnswer
          ? <StatusIcon kind="needs-input" decorative />
          : <StatusIcon kind="autopilot" decorative />}
        <span className="shrink-0 font-medium text-agent">{minimums ? "Custom Autopilot" : "Autopilot"}</span>
        <span className="min-w-0 flex-1 truncate text-text-secondary">
          {waitingForAnswer
            ? "waiting for your answer before it continues"
            : minimums
              ? `Minimum ${formatMinimums(minimums)}${timeMinimumEnd(minimums, progress)}`
              : "working on its own until the task is done"}
        </span>
        {sessionId && runId && (minimums
          // An icon keeps the time the minimum ends in view on a phone.
          ? <IconButton label="Change minimums" className="shrink-0" data-autopilot-minimums="edit"
            onClick={() => openEditor(runId)}><Pencil size={14} /></IconButton>
          : <Button size="sm" variant="ghost" className="shrink-0" data-autopilot-minimums="edit"
            onClick={() => openEditor(runId)}>Set minimums</Button>)}
      </div>
      {editing && <CustomAutopilotDialog value={minimums} running pending={pending} error={error}
        onApply={apply} onClose={() => setEditing(undefined)} />}
    </div>
  );
}
