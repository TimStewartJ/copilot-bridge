import { describe, expect, it } from "vitest";
import { resolveVoiceSubmitMode } from "./voice-submit-mode";

describe("resolveVoiceSubmitMode", () => {
  it.each([
    ["an empty composer", { text: "  ", attachmentCount: 0 }, "autosend"],
    ["typed text", { text: "draft", attachmentCount: 0 }, "insert"],
    ["an attachment", { text: "", attachmentCount: 1 }, "insert"],
    ["an attachment still uploading", { text: "", attachmentCount: 0, uploadingCount: 1 }, "insert"],
    ["a composer that cannot send yet", { text: "", attachmentCount: 0, sendBlocked: true }, "insert"],
  ] as const)("with %s", (_name, context, expected) => {
    expect(resolveVoiceSubmitMode(context)).toBe(expected);
  });
});
