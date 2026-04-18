import { describe, expect, it } from "vitest";
import {
  canAutoSendVoiceTranscript,
  resolveVoiceSubmitMode,
  resolveVoiceSubmitModeAfterRecording,
} from "./voice-submit-mode";

describe("voice submit mode helpers", () => {
  it("auto-sends only from an empty, sendable composer", () => {
    expect(canAutoSendVoiceTranscript({
      text: "   ",
      attachmentCount: 0,
      sendBlocked: false,
      uploadingCount: 0,
    })).toBe(true);
    expect(resolveVoiceSubmitMode({
      text: "",
      attachmentCount: 0,
      sendBlocked: false,
      uploadingCount: 0,
    })).toBe("autosend");
  });

  it("falls back to review mode when text, attachments, or blocking state are present", () => {
    expect(resolveVoiceSubmitMode({
      text: "draft",
      attachmentCount: 0,
      sendBlocked: false,
      uploadingCount: 0,
    })).toBe("insert");
    expect(resolveVoiceSubmitMode({
      text: "",
      attachmentCount: 1,
      sendBlocked: false,
      uploadingCount: 0,
    })).toBe("insert");
    expect(resolveVoiceSubmitMode({
      text: "",
      attachmentCount: 0,
      sendBlocked: true,
      uploadingCount: 0,
    })).toBe("insert");
    expect(resolveVoiceSubmitMode({
      text: "",
      attachmentCount: 0,
      sendBlocked: false,
      uploadingCount: 1,
    })).toBe("insert");
  });

  it("requires both the recording start and stop states to qualify for auto-send", () => {
    expect(resolveVoiceSubmitModeAfterRecording("autosend", {
      text: "",
      attachmentCount: 0,
      sendBlocked: false,
      uploadingCount: 0,
    })).toBe("autosend");
    expect(resolveVoiceSubmitModeAfterRecording("insert", {
      text: "",
      attachmentCount: 0,
      sendBlocked: false,
      uploadingCount: 0,
    })).toBe("insert");
    expect(resolveVoiceSubmitModeAfterRecording("autosend", {
      text: "draft",
      attachmentCount: 0,
      sendBlocked: false,
      uploadingCount: 0,
    })).toBe("insert");
  });
});
