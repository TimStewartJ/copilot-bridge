import { StatusIcon } from "../../design/primitives";
import { DS } from "../../design/tokens";
import type { CustomAutopilot, CustomAutopilotProgress } from "../../../shared/send-mode.js";
import { formatMinimums } from "./CustomAutopilotDialog";

interface AutopilotRunLineProps {
  /** A question is open; Autopilot waits for its answer, so the run is not going on its own. */
  waitingForAnswer: boolean;
  minimums?: CustomAutopilot;
  /** When the Custom Autopilot run started, so a time minimum can show when it is reached. */
  progress?: CustomAutopilotProgress;
}

/** ", at least until 6:42 PM" for a time minimum whose start is known. */
function timeMinimumEnd(minimums: CustomAutopilot, progress: CustomAutopilotProgress | undefined): string {
  const startedAt = progress ? Date.parse(progress.startedAt) : NaN;
  if (minimums.minMinutes === undefined || !Number.isFinite(startedAt)) return "";
  const end = new Date(startedAt + minimums.minMinutes * 60_000);
  return `, at least until ${end.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
}

/** Shown for a whole autopilot run, so it is clear the run will not stop to wait for the user. */
export default function AutopilotRunLine({ waitingForAnswer, minimums, progress }: AutopilotRunLineProps) {
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
        <span className="min-w-0 truncate text-text-secondary">
          {waitingForAnswer
            ? "waiting for your answer before it continues"
            : minimums
              ? `Minimum ${formatMinimums(minimums)}${timeMinimumEnd(minimums, progress)}`
              : "working on its own until the task is done"}
        </span>
      </div>
    </div>
  );
}
