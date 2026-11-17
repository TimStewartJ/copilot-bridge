const MB = 1024 * 1024;

/** Event logs this large are flagged on the chat's row; smaller ones show size in its menu. */
export const LARGE_SESSION_LOG_BYTES = 50 * MB;

/** About 1 s to open or resume here (real log read at ~7 ms/MB); cost grows with size. */
export const VERY_LARGE_SESSION_LOG_BYTES = 150 * MB;

export type SessionLogSizeLevel = "normal" | "large" | "very-large";

export interface SessionLogSize {
  level: SessionLogSizeLevel;
  /** "37 MB" */
  size: string;
  /** The word a flagged row shows before its size; null when the size is ordinary. */
  label: string | null;
  /** What the size means for the reader; null when the size is ordinary. */
  hint: string | null;
}

export function formatSessionLogSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < MB) return `${Math.round(bytes / 1024)} KB`;
  const megabytes = bytes / MB;
  if (megabytes < 10) return `${megabytes.toFixed(1)} MB`;
  // Compare the rounded figure so that 1023.6 MB reads "1.0 GB", not "1024 MB".
  if (Math.round(megabytes) < 1024) return `${Math.round(megabytes)} MB`;
  return `${(megabytes / 1024).toFixed(1)} GB`;
}

/** Null when the size is unknown or the log is empty: an absent figure is not drawn. */
export function describeSessionLogSize(bytes: number | undefined): SessionLogSize | null {
  if (!bytes || bytes <= 0) return null;
  const size = formatSessionLogSize(bytes);
  if (bytes >= VERY_LARGE_SESSION_LOG_BYTES) {
    return {
      level: "very-large",
      size,
      label: "Very large",
      hint: "Slow to open. Continue in a new chat, or archive this one.",
    };
  }
  if (bytes >= LARGE_SESSION_LOG_BYTES) {
    return {
      level: "large",
      size,
      label: "Large",
      hint: "Larger than most chats; opens more slowly as it grows.",
    };
  }
  return { level: "normal", size, label: null, hint: null };
}
