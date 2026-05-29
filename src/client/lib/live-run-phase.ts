import type { SendMode } from "../../shared/send-mode.js";

export type LiveRunPhase =
  | "idle"
  | "creating"
  | "submitting"
  | "reconnecting"
  | "thinking"
  | "working"
  | "responding";

export interface LiveRunPhaseInput {
  creating: boolean;
  isStreaming: boolean;
  streamStatus: "idle" | "sending" | "thinking" | "streaming";
  pendingOrigin: "message" | "reconnect" | null;
  runMode?: SendMode;
  streamingContent: string;
  activeTrackCount: number;
  intentText: string;
  hadVisibleOutput: boolean;
}

export interface LiveRunHeaderState {
  phase: Exclude<LiveRunPhase, "idle">;
  label: string;
  title: string;
  detail: string;
  tone: "creating" | "sending" | "thinking";
}

export function deriveLiveRunHeaderState(input: LiveRunPhaseInput): LiveRunHeaderState | null {
  if (input.creating && !input.isStreaming) {
    return {
      phase: "creating",
      label: "Creating",
      title: "Starting a new chat session",
      detail: "We're creating the session before the assistant can begin responding.",
      tone: "creating",
    };
  }

  if (!input.isStreaming) return null;

  if (input.streamStatus === "sending") {
    if (input.pendingOrigin === "reconnect") {
      return {
        phase: "reconnecting",
        label: "Reconnecting",
        title: "Reopening the live response stream",
        detail: "The session is already busy; reconnecting so live updates and parallel tracks stay in sync.",
        tone: "sending",
      };
    }
    if (input.runMode === "autopilot") {
      return {
        phase: "submitting",
        label: "Autopilot",
        title: "Starting autopilot run",
        detail: "Copilot will continue until the task completes, errors, is stopped, or hits a limit.",
        tone: "sending",
      };
    }
    return {
      phase: "submitting",
      label: "Sending",
      title: "Handing off your message",
      detail: "The session has your prompt and is opening the response stream.",
      tone: "sending",
    };
  }

  if (input.streamingContent) {
    return {
      phase: "responding",
      label: input.runMode === "autopilot" ? "Autopilot" : "Responding",
      title: input.intentText || (input.runMode === "autopilot" ? "Autopilot responding" : "Streaming response"),
      detail: input.activeTrackCount > 0
        ? `${input.activeTrackCount} track${input.activeTrackCount === 1 ? "" : "s"} still running in parallel.`
        : input.runMode === "autopilot"
          ? "Copilot is streaming visible text and may continue into the next step."
          : "The assistant is streaming visible text.",
      tone: "thinking",
    };
  }

  if (input.activeTrackCount > 0) {
    return {
      phase: "working",
      label: input.runMode === "autopilot" ? "Autopilot" : "Working",
      title: input.activeTrackCount > 1
        ? `${input.activeTrackCount} parallel tracks running`
        : "1 track running",
      detail: input.intentText
        ? `${input.intentText}. Tools and subagents are actively working.`
        : input.runMode === "autopilot"
          ? "Copilot is continuing through tool work on its own."
          : "Tools and subagents are actively working.",
      tone: "thinking",
    };
  }

  return {
    phase: "thinking",
    label: input.runMode === "autopilot" ? "Autopilot" : "Thinking",
    title: input.intentText || (
      input.hadVisibleOutput
        ? "Waiting for the next update"
        : input.runMode === "autopilot"
          ? "Autopilot running"
          : "Waiting for the first response"
    ),
    detail: input.hadVisibleOutput
      ? "The run is still active, but there is no visible text or tool activity right now."
      : input.runMode === "autopilot"
        ? "Copilot is working before any text or tool activity is visible."
        : "The assistant is working before any text or tool activity is visible.",
    tone: "thinking",
  };
}
