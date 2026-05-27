import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  isCopilotContextTier,
  type CopilotContextTier,
} from "../shared/copilot-context.js";

export const BRIDGE_SESSION_MODEL_STATE_FILE = "bridge-model-state.json";

export interface PersistedSessionModelState {
  model?: string;
  reasoningEffort?: string;
  contextTier?: CopilotContextTier;
  modelCapabilities?: Record<string, unknown>;
  updatedAt?: string;
}

export function readPersistedSessionModelState(sessionStateDir: string): PersistedSessionModelState {
  try {
    const raw = JSON.parse(readFileSync(join(sessionStateDir, BRIDGE_SESSION_MODEL_STATE_FILE), "utf8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const record = raw as Record<string, unknown>;
    return {
      ...(typeof record.model === "string" && record.model.trim() ? { model: record.model.trim() } : {}),
      ...(typeof record.reasoningEffort === "string" && record.reasoningEffort.trim()
        ? { reasoningEffort: record.reasoningEffort.trim() }
        : {}),
      ...(isCopilotContextTier(record.contextTier) ? { contextTier: record.contextTier } : {}),
      ...(isRecord(record.modelCapabilities) ? { modelCapabilities: record.modelCapabilities } : {}),
      ...(typeof record.updatedAt === "string" && record.updatedAt.trim() ? { updatedAt: record.updatedAt.trim() } : {}),
    };
  } catch {
    return {};
  }
}

export function writePersistedSessionModelState(
  sessionStateDir: string,
  state: PersistedSessionModelState,
): void {
  mkdirSync(sessionStateDir, { recursive: true });
  const persisted: PersistedSessionModelState = {
    ...(state.model ? { model: state.model } : {}),
    ...(state.reasoningEffort ? { reasoningEffort: state.reasoningEffort } : {}),
    ...(state.contextTier ? { contextTier: state.contextTier } : {}),
    ...(state.modelCapabilities ? { modelCapabilities: state.modelCapabilities } : {}),
    updatedAt: state.updatedAt ?? new Date().toISOString(),
  };
  const target = join(sessionStateDir, BRIDGE_SESSION_MODEL_STATE_FILE);
  const tmp = join(sessionStateDir, `.${BRIDGE_SESSION_MODEL_STATE_FILE}.${randomUUID()}.tmp`);
  writeFileSync(tmp, `${JSON.stringify(persisted, null, 2)}\n`);
  renameSync(tmp, target);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
