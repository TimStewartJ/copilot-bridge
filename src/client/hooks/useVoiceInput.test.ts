import { describe, expect, it } from "vitest";
import { describeVoiceCaptureError } from "./useVoiceInput";

describe("describeVoiceCaptureError", () => {
  it("replaces Firefox and browser not-found mic errors with clearer guidance", () => {
    expect(describeVoiceCaptureError({
      name: "NotFoundError",
      message: "The object can not be found here.",
    })).toBe("No microphone was found. Check your browser and OS audio input settings, then try again.");

    expect(describeVoiceCaptureError({
      name: "DevicesNotFoundError",
      message: "No audio input",
    })).toBe("No microphone was found. Check your browser and OS audio input settings, then try again.");
  });

  it("maps denied permissions to a browser-specific mic access message", () => {
    expect(describeVoiceCaptureError({
      name: "NotAllowedError",
      message: "The request is not allowed by the user agent or the platform in the current context",
    })).toBe("Microphone access was denied. Allow microphone access in your browser settings and try again.");
  });

  it("maps device-busy failures to a microphone unavailable message", () => {
    expect(describeVoiceCaptureError({
      name: "NotReadableError",
      message: "Failed to allocate videosource",
    })).toBe("The microphone is unavailable right now. Close other apps or tabs that might be using it, then try again.");
  });

  it("falls back to the original error text for unknown failures", () => {
    expect(describeVoiceCaptureError(new Error("Unexpected failure"))).toBe("Unexpected failure");
  });
});
