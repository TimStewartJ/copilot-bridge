import { describe, expect, it } from "vitest";
import { resolveBackgroundVoiceSubmitMode } from "./background-voice-delivery";

describe("background voice delivery", () => {
  it("keeps auto-send only when the target is still empty and idle", () => {
    expect(resolveBackgroundVoiceSubmitMode({
      submitMode: "autosend",
      hasDraftContent: false,
      targetBusy: false,
    })).toBe("autosend");
  });

  it("downgrades auto-send when the target gains draft content or becomes busy", () => {
    expect(resolveBackgroundVoiceSubmitMode({
      submitMode: "autosend",
      hasDraftContent: true,
      targetBusy: false,
    })).toBe("insert");
    expect(resolveBackgroundVoiceSubmitMode({
      submitMode: "autosend",
      hasDraftContent: false,
      targetBusy: true,
    })).toBe("insert");
  });

  it("preserves explicit review mode", () => {
    expect(resolveBackgroundVoiceSubmitMode({
      submitMode: "insert",
      hasDraftContent: false,
      targetBusy: false,
    })).toBe("insert");
  });
});
