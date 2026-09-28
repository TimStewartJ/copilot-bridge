import { StatusIcon } from "../../design/primitives";
import { DS } from "../../design/tokens";

interface AutopilotRunLineProps {
  /** A question is open. Autopilot still waits for its answer, so the run is not going on its own. */
  waitingForAnswer: boolean;
}

/**
 * Stays above the composer for the whole of an autopilot run, so it is clear the run will not stop
 * for you. The transcript's own status line only appears in pauses.
 */
export default function AutopilotRunLine({ waitingForAnswer }: AutopilotRunLineProps) {
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
        <span className="shrink-0 font-medium text-agent">Autopilot</span>
        <span className="min-w-0 truncate text-text-secondary">
          {waitingForAnswer
            ? "waiting for your answer before it continues"
            : "working on its own until the task is done"}
        </span>
      </div>
    </div>
  );
}
