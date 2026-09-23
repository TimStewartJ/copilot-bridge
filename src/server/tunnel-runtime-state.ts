import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import type { ProcessIdentity } from "./platform.js";
import { normalizeTunnelName } from "./tunnel-config.js";

export const TUNNEL_RUNTIME_STATE_FILE_NAME = "tunnel-runtime.json";

export type TunnelRuntimeState = {
  url: string | null;
  port: number;
  process: ProcessIdentity | null;
  updatedAt: string;
};

/**
 * Additional tunnels keep their own state file so each supervisor can clean up its
 * own orphan. Only the primary file feeds the server's public URL.
 */
export function additionalTunnelRuntimeStateFileName(tunnelName: string): string {
  return `tunnel-runtime-${tunnelName}.json`;
}

/** Names of additional tunnels that still have a state file, for orphan cleanup. */
export function listAdditionalTunnelRuntimeStateNames(dataDir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dataDir);
  } catch {
    return [];
  }
  const names: string[] = [];
  for (const entry of entries) {
    const match = /^tunnel-runtime-(.+)\.json$/.exec(entry);
    if (match && normalizeTunnelName(match[1]) === match[1]) names.push(match[1]);
  }
  return names.sort();
}

function statePath(dataDir: string, fileName: string): string {
  return join(dataDir, fileName);
}

function normalizeState(value: unknown): TunnelRuntimeState | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if ((record.url !== null && typeof record.url !== "string")
    || !Number.isInteger(record.port)
    || (record.port as number) <= 0) {
    return null;
  }
  if (typeof record.url === "string") {
    try {
      const url = new URL(record.url);
      if (url.protocol !== "https:") return null;
    } catch {
      return null;
    }
  }

  const processRecord = record.process && typeof record.process === "object"
    ? record.process as Record<string, unknown>
    : null;
  const process = processRecord
    && Number.isInteger(processRecord.pid)
    && (processRecord.pid as number) > 0
    && typeof processRecord.startMarker === "string"
    && processRecord.startMarker.length > 0
    ? {
        pid: processRecord.pid as number,
        startMarker: processRecord.startMarker,
      }
    : null;

  return {
    url: typeof record.url === "string" ? record.url.replace(/\/+$/, "") : null,
    port: record.port as number,
    process,
    updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : "",
  };
}

export function readTunnelRuntimeState(
  dataDir: string,
  fileName = TUNNEL_RUNTIME_STATE_FILE_NAME,
): TunnelRuntimeState | null {
  try {
    return normalizeState(JSON.parse(readFileSync(statePath(dataDir, fileName), "utf8")));
  } catch {
    return null;
  }
}

export function writeTunnelRuntimeState(
  dataDir: string,
  state: TunnelRuntimeState,
  fileName = TUNNEL_RUNTIME_STATE_FILE_NAME,
): void {
  mkdirSync(dataDir, { recursive: true });
  const finalPath = statePath(dataDir, fileName);
  const tempPath = join(dirname(finalPath), `.${basename(finalPath)}.${randomUUID()}.tmp`);
  try {
    writeFileSync(tempPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    renameSync(tempPath, finalPath);
  } finally {
    rmSync(tempPath, { force: true });
  }
}

export function clearTunnelRuntimeState(
  dataDir: string,
  fileName = TUNNEL_RUNTIME_STATE_FILE_NAME,
): void {
  rmSync(statePath(dataDir, fileName), { force: true });
}
