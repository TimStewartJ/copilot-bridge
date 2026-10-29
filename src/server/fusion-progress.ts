// A Copilot Fusion turn at High or Max runs its phases out of sight: the runtime adds their messages
// and tool calls to the chat only when the turn commits, which can be minutes later. Meanwhile it
// reports content-free progress (which model is on which phase, tools starting and finishing). This
// turns that progress into the run's status line.
import { isRecord } from "../shared/is-record.js";

const PHASE_VERBS: Readonly<Record<string, string>> = {
  primary: "working",
  follow_up: "working",
  draft: "drafting",
  critic: "reviewing",
  revision: "revising",
  judge: "checking the answer",
  repair: "redoing the answer",
};

export const FUSION_PROGRESS_EVENT_TYPES: ReadonlySet<string> = new Set([
  "session.fusion_resolved",
  "assistant.fusion_phase_started",
  "assistant.fusion_phase_activity",
  "assistant.fusion_phase_completed",
  "assistant.fusion_phase_failed",
  "session.fusion_commit_started",
  "session.fusion_completed",
  "session.fusion_route_failed",
]);

export interface FusionProgress {
  /** The status this event leads to: text to show, "" to clear it, undefined to leave it as it is. */
  observe(event: { type?: unknown; data?: unknown }): string | undefined;
}

/** One per run. `modelName` gives a model's display name. */
export function createFusionProgress(modelName: (modelId: string) => string): FusionProgress {
  const running = new Map<string, { model: string; kind: string }>();
  let toolsRun = 0;
  let shown: string | undefined;

  const describe = (): string | undefined => {
    const phases = [...running.values()];
    const latest = phases.at(-1);
    if (!latest) return undefined;
    // Critique runs its reviewers side by side.
    const alongside = phases.filter((phase) => phase.kind === latest.kind).length;
    const who = alongside > 1 ? `${alongside} models` : modelName(latest.model);
    const tools = toolsRun > 0 ? ` · ${toolsRun} tool${toolsRun === 1 ? "" : "s"} run` : "";
    return `Copilot Fusion · ${who} ${PHASE_VERBS[latest.kind] ?? "working"}${tools}`;
  };
  const show = (status: string | undefined): string | undefined => {
    if (status === undefined || status === shown) return undefined;
    shown = status;
    return status;
  };

  return {
    observe(event) {
      const data = isRecord(event.data) ? event.data : {};
      const phaseId = typeof data.phaseId === "string" ? data.phaseId : undefined;
      switch (event.type) {
        case "session.fusion_resolved":
          running.clear();
          toolsRun = 0;
          return undefined;
        case "assistant.fusion_phase_started":
          if (!phaseId || typeof data.model !== "string") return undefined;
          running.set(phaseId, { model: data.model, kind: typeof data.phaseKind === "string" ? data.phaseKind : "" });
          return show(describe());
        case "assistant.fusion_phase_activity":
          if (data.activity !== "tool_completed") return undefined;
          toolsRun += 1;
          return show(describe());
        case "assistant.fusion_phase_completed":
        case "assistant.fusion_phase_failed":
          if (phaseId) running.delete(phaseId);
          return show(describe());
        // From the commit on, the turn's own messages and tool calls arrive and speak for themselves.
        case "session.fusion_commit_started":
        case "session.fusion_completed":
        case "session.fusion_route_failed":
          running.clear();
          toolsRun = 0;
          return show("");
        default:
          return undefined;
      }
    },
  };
}
