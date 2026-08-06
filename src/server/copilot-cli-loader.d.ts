export function patchCopilotAppSource(source: string): string;

export function load(
  url: string,
  context: unknown,
  nextLoad: (url: string, context: unknown) => Promise<Record<string, unknown>>,
): Promise<Record<string, unknown>>;
