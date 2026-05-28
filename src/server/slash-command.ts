export interface ParsedSlashCommand {
  name: string;
  input: string;
}

export function parseSlashCommandPrompt(prompt: string): ParsedSlashCommand | null {
  if (!prompt.startsWith("/") || prompt.startsWith("//")) return null;
  const match = prompt.match(/^\/([^\s/]+)(?:\s+([\s\S]*))?$/);
  if (!match) return null;
  return {
    name: match[1]!,
    input: match[2]?.trim() ?? "",
  };
}
