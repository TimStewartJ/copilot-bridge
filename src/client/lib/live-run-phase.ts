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
  pendingOrigin: "message" | "fleet" | "reconnect" | null;
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
    if (input.pendingOrigin === "fleet") {
      return {
        phase: "submitting",
        label: "Sending",
        title: "Launching Fleet run",
        detail: "The session is starting a parallel plan run and opening the response stream.",
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
      label: "Responding",
      title: input.intentText || "Streaming response",
      detail: input.activeTrackCount > 0
        ? `${input.activeTrackCount} track${input.activeTrackCount === 1 ? "" : "s"} still running in parallel.`
        : "The assistant is streaming visible text.",
      tone: "thinking",
    };
  }

  if (input.activeTrackCount > 0) {
    return {
      phase: "working",
      label: "Working",
      title: input.activeTrackCount > 1
        ? `${input.activeTrackCount} parallel tracks running`
        : "1 track running",
      detail: input.intentText
        ? `${input.intentText}. Tools and subagents are actively working.`
        : "Tools and subagents are actively working.",
      tone: "thinking",
    };
  }

  return {
    phase: "thinking",
    label: "Thinking",
    title: input.hadVisibleOutput
      ? "Waiting for the next update"
      : input.intentText || "Waiting for the first response",
    detail: input.hadVisibleOutput
      ? "The run is still active, but there is no visible text or tool activity right now."
      : "The assistant is working before any text or tool activity is visible.",
    tone: "thinking",
  };
}
