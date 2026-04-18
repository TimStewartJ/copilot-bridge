export function mergeTranscript(current: string, transcript: string): string {
  const cleanTranscript = transcript.trim();
  if (!cleanTranscript) return current;
  if (!current.trim()) return cleanTranscript;
  return /\s$/.test(current) ? `${current}${cleanTranscript}` : `${current} ${cleanTranscript}`;
}
