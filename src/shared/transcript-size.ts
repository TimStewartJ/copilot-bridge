export const TRANSCRIPT_SIZE_WARNING_BYTES = 32 * 1024 * 1024;

function formatMegabytes(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1);
}

export function getTranscriptSizeWarning(bytes?: number): string | null {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < TRANSCRIPT_SIZE_WARNING_BYTES) {
    return null;
  }

  return `Large transcript (${formatMegabytes(bytes)} MB). Long sessions slow down history reads and make recurring defers expensive; consider starting a fresh session for new work.`;
}
