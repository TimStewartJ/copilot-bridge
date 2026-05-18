import { COMMAND_OUTPUT_CAPTURE_LIMIT } from "./staging-preview-shared.js";

export type CapturedCommandOutput = {
  output: string;
  truncatedChars: number;
};

export function appendCapturedCommandOutput(capture: CapturedCommandOutput, chunk: unknown): void {
  const text = String(chunk);
  if (!text) return;

  if (text.length >= COMMAND_OUTPUT_CAPTURE_LIMIT) {
    capture.truncatedChars += capture.output.length + text.length - COMMAND_OUTPUT_CAPTURE_LIMIT;
    capture.output = text.slice(-COMMAND_OUTPUT_CAPTURE_LIMIT);
    return;
  }

  const combinedLength = capture.output.length + text.length;
  if (combinedLength <= COMMAND_OUTPUT_CAPTURE_LIMIT) {
    capture.output += text;
    return;
  }

  const droppedChars = combinedLength - COMMAND_OUTPUT_CAPTURE_LIMIT;
  capture.truncatedChars += droppedChars;
  capture.output = (capture.output + text).slice(droppedChars);
}

export function renderCapturedCommandOutput(label: string, capture: CapturedCommandOutput): string {
  if (capture.truncatedChars === 0) return capture.output;
  const notice =
    `[${label} truncated: kept last ${capture.output.length} characters, dropped ${capture.truncatedChars} characters.]`;
  return joinFailureSections(capture.output, notice) ?? notice;
}

export function normalizeFailureText(text: string | undefined): string | undefined {
  const trimmed = text?.trim();
  return trimmed ? trimmed : undefined;
}

export function truncateFailureText(text: string | undefined, maxChars: number): string | undefined {
  const normalized = normalizeFailureText(text);
  if (!normalized) return undefined;
  return normalized.length <= maxChars ? normalized : `…${normalized.slice(-maxChars)}`;
}

export function joinFailureSections(...sections: Array<string | undefined>): string | undefined {
  const present = sections
    .map((section) => normalizeFailureText(section))
    .filter((section): section is string => Boolean(section));
  return present.length > 0 ? present.join("\n\n") : undefined;
}
