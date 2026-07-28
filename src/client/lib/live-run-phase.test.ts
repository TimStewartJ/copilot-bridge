import { describe, expect, it } from "vitest";
import { deriveLiveRunHeaderState } from "./live-run-phase";

describe("deriveLiveRunHeaderState", () => {
  it("derives phase, label, and title across reconnect, working, thinking, and autopilot states", () => {
    // reconnect origin → reconnecting phase
    expect(deriveLiveRunHeaderState({
      creating: false, isStreaming: true, streamStatus: "sending", pendingOrigin: "reconnect",
      streamingContent: "", activeTrackCount: 0, intentText: "", hadVisibleOutput: false,
    })).toMatchObject({ phase: "reconnecting", label: "Reconnecting" });

    // active tracks → working with track count title
    expect(deriveLiveRunHeaderState({
      creating: false, isStreaming: true, streamStatus: "streaming", pendingOrigin: null,
      streamingContent: "", activeTrackCount: 2, intentText: "Exploring codebase", hadVisibleOutput: true,
    })).toMatchObject({ phase: "working", title: "2 parallel tracks running" });

    // post-output thinking without intent → generic wait title
    expect(deriveLiveRunHeaderState({
      creating: false, isStreaming: true, streamStatus: "thinking", pendingOrigin: null,
      streamingContent: "", activeTrackCount: 0, intentText: "", hadVisibleOutput: true,
    })).toMatchObject({ phase: "thinking", title: "Waiting for the next update" });

    // post-output thinking with intent → shows current intent
    expect(deriveLiveRunHeaderState({
      creating: false, isStreaming: true, streamStatus: "thinking", pendingOrigin: null,
      streamingContent: "", activeTrackCount: 0, intentText: "Running validation", hadVisibleOutput: true,
    })).toMatchObject({ phase: "thinking", title: "Running validation" });

    // autopilot run mode → surfaces in label and title
    expect(deriveLiveRunHeaderState({
      creating: false, isStreaming: true, streamStatus: "thinking", pendingOrigin: "message",
      runMode: "autopilot", streamingContent: "", activeTrackCount: 0, intentText: "", hadVisibleOutput: false,
    })).toMatchObject({ phase: "thinking", label: "Autopilot", title: "Autopilot running" });
  });
});
