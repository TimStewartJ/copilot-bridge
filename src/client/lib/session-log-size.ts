const MB = 1024 * 1024;

/** A chat whose event log is this large is flagged on its row. Smaller chats keep the size in the row's menu. */
export const LARGE_SESSION_LOG_BYTES = 50 * MB;

/**
 * From here opening or resuming the chat is a wait the reader notices. Reading a real log in full
 * measured about 7 ms per MB and a cold resume slightly less, so both take about a second at this
 * size and grow with it (a 1.8 GB log took 5 s to resume and 11 s or more to read).
 */
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
      hint: "Opening and resuming take a second or more. Continue in a new chat, or archive this one.",
    };
  }
  if (bytes >= LARGE_SESSION_LOG_BYTES) {
    return {
      level: "large",
      size,
      label: "Large",
      hint: "Larger than most chats. It opens and resumes more slowly as it grows.",
    };
  }
  return { level: "normal", size, label: null, hint: null };
}
