/** send = Ctrl/Cmd+Enter (skips slash menu); submit = plain hardware Enter (accepts or sends). */
export type ComposerKeyIntent = "composing" | "newline" | "send" | "submit" | "other";

export interface ComposerKeyEvent {
  key: string;
  code?: string;
  keyCode?: number;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  nativeEvent?: { isComposing?: boolean };
}

export interface ComposerKeyContext {
  /** Composition the composer saw start and has not seen end. */
  composing: boolean;
  /** Read only when the answer depends on it. */
  usesSoftKeyboard: () => boolean;
  hasFinePointer: () => boolean;
}

export function classifyComposerKey(event: ComposerKeyEvent, context: ComposerKeyContext): ComposerKeyIntent {
  if (context.composing || event.nativeEvent?.isComposing || event.keyCode === 229) return "composing";
  if (event.key !== "Enter") return "other";
  if (event.shiftKey) return "newline";
  if (event.ctrlKey || event.metaKey) return "send";
  // A physical-style code alone is not proof: some software keyboards supply it too.
  const hardwareStyleEnter = event.code === "Enter" || event.code === "NumpadEnter";
  if (context.usesSoftKeyboard() || (!context.hasFinePointer() && !hardwareStyleEnter)) return "newline";
  return "submit";
}
