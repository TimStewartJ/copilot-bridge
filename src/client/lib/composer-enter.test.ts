import { describe, expect, it } from "vitest";
import { classifyComposerKey, type ComposerKeyEvent, type ComposerKeyIntent } from "./composer-enter";

type Device = "desktop" | "touch" | "touch with soft keyboard" | "fine pointer with soft keyboard";

const DEVICES: Record<Device, { softKeyboard: boolean; finePointer: boolean }> = {
  desktop: { softKeyboard: false, finePointer: true },
  touch: { softKeyboard: false, finePointer: false },
  "touch with soft keyboard": { softKeyboard: true, finePointer: false },
  "fine pointer with soft keyboard": { softKeyboard: true, finePointer: true },
};

function classify(event: ComposerKeyEvent, device: Device, composing = false): ComposerKeyIntent {
  const { softKeyboard, finePointer } = DEVICES[device];
  return classifyComposerKey(event, {
    composing,
    usesSoftKeyboard: () => softKeyboard,
    hasFinePointer: () => finePointer,
  });
}

describe("classifyComposerKey", () => {
  it.each<{ label: string; event: ComposerKeyEvent; device: Device; expected: ComposerKeyIntent }>([
    { label: "desktop Enter without a code", event: { key: "Enter" }, device: "desktop", expected: "submit" },
    { label: "touch hardware-style Enter", event: { key: "Enter", code: "Enter" }, device: "touch", expected: "submit" },
    { label: "touch keypad Enter", event: { key: "Enter", code: "NumpadEnter" }, device: "touch", expected: "submit" },
    { label: "touch Enter without a code", event: { key: "Enter" }, device: "touch", expected: "newline" },
    { label: "touch Enter with an unrelated physical code", event: { key: "Enter", code: "KeyA" }, device: "touch", expected: "newline" },
    { label: "touch Cmd+Enter", event: { key: "Enter", metaKey: true }, device: "touch", expected: "send" },
    { label: "soft keyboard Enter with a physical-style code", event: { key: "Enter", code: "Enter" }, device: "touch with soft keyboard", expected: "newline" },
    { label: "soft keyboard Ctrl+Enter", event: { key: "Enter", code: "Enter", ctrlKey: true }, device: "touch with soft keyboard", expected: "send" },
    { label: "soft keyboard occluding a fine-pointer device", event: { key: "Enter", code: "Enter" }, device: "fine pointer with soft keyboard", expected: "newline" },
    { label: "Shift+Ctrl+Enter", event: { key: "Enter", shiftKey: true, ctrlKey: true }, device: "desktop", expected: "newline" },
    { label: "Tab", event: { key: "Tab", code: "Tab" }, device: "desktop", expected: "other" },
  ])("$label is $expected", ({ event, device, expected }) => {
    expect(classify(event, device)).toBe(expected);
  });

  it.each<{ label: string; event: ComposerKeyEvent; composing?: boolean }>([
    { label: "Enter while the composer tracks a composition", event: { key: "Enter", code: "Enter" }, composing: true },
    { label: "an IME confirmation flagged as composing", event: { key: "Enter", code: "Enter", ctrlKey: true, keyCode: 13, nativeEvent: { isComposing: true } } },
    { label: "an IME confirmation reported as key code 229", event: { key: "Enter", code: "Enter", ctrlKey: true, keyCode: 229, nativeEvent: { isComposing: false } } },
    { label: "an arrow key during composition", event: { key: "ArrowDown" }, composing: true },
  ])("leaves $label to the input method", ({ event, composing }) => {
    expect(classify(event, "desktop", composing)).toBe("composing");
  });
});
