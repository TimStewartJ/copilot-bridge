import { Buffer } from "node:buffer";

export const DEFER_CHECKPOINT_MAX_BYTES = 16 * 1024;
export type DeferCheckpoint = Record<string, unknown>;

function isCheckpoint(value: unknown): value is DeferCheckpoint {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function serializeDeferCheckpoint(checkpoint: DeferCheckpoint): string {
  if (!isCheckpoint(checkpoint)) {
    throw new Error("Deferred checkpoint must be a JSON object.");
  }
  const json = JSON.stringify(checkpoint).replaceAll("<", "\\u003c");
  if (Buffer.byteLength(json, "utf8") > DEFER_CHECKPOINT_MAX_BYTES) {
    throw new Error(`Deferred checkpoint exceeds ${DEFER_CHECKPOINT_MAX_BYTES} bytes.`);
  }
  return json;
}

export function parseDeferCheckpointJson(json: string): DeferCheckpoint {
  if (Buffer.byteLength(json, "utf8") > DEFER_CHECKPOINT_MAX_BYTES) {
    throw new Error(`Deferred checkpoint exceeds ${DEFER_CHECKPOINT_MAX_BYTES} bytes.`);
  }
  let checkpoint: unknown;
  try {
    checkpoint = JSON.parse(json);
  } catch {
    throw new Error("Deferred checkpoint must contain valid JSON.");
  }
  if (!isCheckpoint(checkpoint)) {
    throw new Error("Deferred checkpoint must be a JSON object.");
  }
  serializeDeferCheckpoint(checkpoint);
  return checkpoint;
}
