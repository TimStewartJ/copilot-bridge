import { readFileSync, writeFileSync } from "node:fs";

export type RestartValidationMode = "deploy" | "operational";

export interface RestartSignal {
  requestedAt: string;
  validationMode: RestartValidationMode;
  source?: string;
}

function isRestartValidationMode(value: unknown): value is RestartValidationMode {
  return value === "deploy" || value === "operational";
}

export function createRestartSignal(options: {
  validationMode: RestartValidationMode;
  source?: string;
  requestedAt?: string;
}): RestartSignal {
  return {
    requestedAt: options.requestedAt ?? new Date().toISOString(),
    validationMode: options.validationMode,
    ...(options.source ? { source: options.source } : {}),
  };
}

export function serializeRestartSignal(options: {
  validationMode: RestartValidationMode;
  source?: string;
  requestedAt?: string;
}): string {
  return `${JSON.stringify(createRestartSignal(options))}\n`;
}

export function parseRestartSignalContent(content: string): RestartSignal {
  const trimmed = content.trim();
  if (!trimmed) {
    return createRestartSignal({ validationMode: "deploy" });
  }

  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    if (isRestartValidationMode(parsed.validationMode)) {
      return createRestartSignal({
        validationMode: parsed.validationMode,
        requestedAt: typeof parsed.requestedAt === "string" && parsed.requestedAt.trim()
          ? parsed.requestedAt
          : undefined,
        source: typeof parsed.source === "string" && parsed.source.trim()
          ? parsed.source
          : undefined,
      });
    }
  } catch {
    // Legacy restart.signal files were plain timestamps. Keep them on deploy validation.
  }

  return createRestartSignal({
    validationMode: "deploy",
    requestedAt: trimmed,
  });
}

export function readRestartSignalFile(signalFile: string): RestartSignal {
  try {
    return parseRestartSignalContent(readFileSync(signalFile, "utf-8"));
  } catch {
    return createRestartSignal({ validationMode: "deploy" });
  }
}

export function writeRestartSignalFile(signalFile: string, options: {
  validationMode: RestartValidationMode;
  source?: string;
}): void {
  writeFileSync(signalFile, serializeRestartSignal(options));
}
