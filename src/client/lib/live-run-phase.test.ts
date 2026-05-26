import { describe, expect, it } from "vitest";
import { deriveLiveRunHeaderState } from "./live-run-phase";

describe("deriveLiveRunHeaderState", () => {
  it("distinguishes reconnecting from user submission", () => {
    expect(deriveLiveRunHeaderState({
      creating: false,
      isStreaming: true,
      streamStatus: "sending",
      pendingOrigin: "reconnect",
      streamingContent: "",
      activeTrackCount: 0,
      intentText: "",
      hadVisibleOutput: false,
    })).toMatchObject({
      phase: "reconnecting",
      label: "Reconnecting",
    });
  });

  it("shows working when tracks are active without visible text", () => {
    expect(deriveLiveRunHeaderState({
      creating: false,
      isStreaming: true,
      streamStatus: "streaming",
      pendingOrigin: null,
      streamingContent: "",
      activeTrackCount: 2,
      intentText: "Exploring codebase",
      hadVisibleOutput: true,
    })).toMatchObject({
      phase: "working",
      title: "2 parallel tracks running",
    });
  });

  it("stops calling later empty periods a first response wait", () => {
    expect(deriveLiveRunHeaderState({
      creating: false,
      isStreaming: true,
      streamStatus: "thinking",
      pendingOrigin: null,
      streamingContent: "",
      activeTrackCount: 0,
      intentText: "",
      hadVisibleOutput: true,
    })).toMatchObject({
      phase: "thinking",
      title: "Waiting for the next update",
    });
  });

  it("keeps the current intent visible between later updates", () => {
    expect(deriveLiveRunHeaderState({
      creating: false,
      isStreaming: true,
      streamStatus: "thinking",
      pendingOrigin: null,
      streamingContent: "",
      activeTrackCount: 0,
      intentText: "Running validation",
      hadVisibleOutput: true,
    })).toMatchObject({
      phase: "thinking",
      title: "Running validation",
    });
  });

  it("surfaces autopilot mode in the live run header", () => {
    expect(deriveLiveRunHeaderState({
      creating: false,
      isStreaming: true,
      streamStatus: "thinking",
      pendingOrigin: "message",
      runMode: "autopilot",
      streamingContent: "",
      activeTrackCount: 0,
      intentText: "",
      hadVisibleOutput: false,
    })).toMatchObject({
      phase: "thinking",
      label: "Autopilot",
      title: "Autopilot running",
    });
  });
});
