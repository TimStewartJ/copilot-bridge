import type { VoiceSubmitMode } from "./voice-submit-mode";

const DB_NAME = "copilot-bridge-voice";
const DB_VERSION = 1;
const STORE_NAME = "pending-recordings";

export const MAX_PERSISTED_RECORDING_BYTES = 25 * 1024 * 1024;

export interface PendingVoiceRecording {
  composerKey: string;
  recordingId: string;
  submitMode: VoiceSubmitMode;
  audio: ArrayBuffer;
  mimeType: string;
  sizeBytes: number;
  createdAt: number;
  updatedAt: number;
  serverJobId?: string;
  lastError?: string;
}

export type VoicePersistFailureReason = "too-large" | "unavailable" | "conflict" | "quota";

export interface VoicePersistResult {
  durable: boolean;
  reason?: VoicePersistFailureReason;
}

export interface SavePendingVoiceRecordingInput {
  composerKey: string;
  recordingId: string;
  submitMode: VoiceSubmitMode;
  audio: ArrayBuffer;
  mimeType: string;
}

type PendingRecordingPatch = Partial<Pick<PendingVoiceRecording, "submitMode" | "serverJobId" | "lastError">>;

const memoryFallback = new Map<string, PendingVoiceRecording>();
let indexedDbUnavailable = false;
let dbPromise: Promise<IDBDatabase> | null = null;

function getIndexedDb(): IDBFactory | null {
  if (indexedDbUnavailable) return null;
  if (typeof globalThis === "undefined") return null;
  const factory = (globalThis as { indexedDB?: IDBFactory }).indexedDB;
  return factory ?? null;
}

function openDatabase(): Promise<IDBDatabase> {
  const factory = getIndexedDb();
  if (!factory) return Promise.reject(new Error("IndexedDB is unavailable"));

  if (!dbPromise) {
    dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      let request: IDBOpenDBRequest;
      try {
        request = factory.open(DB_NAME, DB_VERSION);
      } catch (error) {
        reject(error);
        return;
      }

      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: "composerKey" });
        }
      };
      request.onsuccess = () => {
        const db = request.result;
        db.onclose = () => {
          dbPromise = null;
        };
        resolve(db);
      };
      request.onerror = () => reject(request.error ?? new Error("Failed to open voice recording store"));
      request.onblocked = () => reject(new Error("Voice recording store upgrade is blocked"));
    }).catch((error) => {
      dbPromise = null;
      throw error;
    });
  }

  return dbPromise;
}

/**
 * Runs a store transaction and resolves only once the transaction commits, so callers can never
 * observe a write (or delete) that the browser later rolls back.
 */
async function runTransaction<T>(
  mode: IDBTransactionMode,
  work: (store: IDBObjectStore, resolveValue: (value: T) => void) => IDBRequest | { request: IDBRequest; read: (request: IDBRequest) => T } | null,
): Promise<T | undefined> {
  const db = await openDatabase();
  return await new Promise<T | undefined>((resolve, reject) => {
    let transaction: IDBTransaction;
    try {
      transaction = db.transaction(STORE_NAME, mode);
    } catch (error) {
      reject(error);
      return;
    }

    let value: T | undefined;
    let settled = false;

    transaction.oncomplete = () => {
      settled = true;
      resolve(value);
    };
    transaction.onerror = () => {
      if (settled) return;
      settled = true;
      reject(transaction.error ?? new Error("Voice recording transaction failed"));
    };
    transaction.onabort = () => {
      if (settled) return;
      settled = true;
      reject(transaction.error ?? new Error("Voice recording transaction aborted"));
    };

    try {
      const outcome = work(transaction.objectStore(STORE_NAME), (next) => {
        value = next;
      });
      if (outcome && "read" in outcome) {
        outcome.request.onsuccess = () => {
          value = outcome.read(outcome.request);
        };
      }
    } catch (error) {
      try {
        transaction.abort();
      } catch {
        // The transaction may already be finished; the abort/error handler settles the promise.
      }
      if (!settled) {
        settled = true;
        reject(error);
      }
    }
  });
}

function markUnavailable(error: unknown): void {
  const name = (error as { name?: string } | null)?.name;
  if (name === "QuotaExceededError") return;
  indexedDbUnavailable = true;
  dbPromise = null;
}

function isQuotaError(error: unknown): boolean {
  return (error as { name?: string } | null)?.name === "QuotaExceededError";
}

function cloneForMemory(record: PendingVoiceRecording): PendingVoiceRecording {
  return { ...record, audio: record.audio.slice(0) };
}

export async function savePendingVoiceRecording(
  input: SavePendingVoiceRecordingInput,
): Promise<VoicePersistResult> {
  const now = Date.now();
  const record: PendingVoiceRecording = {
    composerKey: input.composerKey,
    recordingId: input.recordingId,
    submitMode: input.submitMode,
    audio: input.audio,
    mimeType: input.mimeType,
    sizeBytes: input.audio.byteLength,
    createdAt: now,
    updatedAt: now,
  };

  const memoryConflict = memoryFallback.get(record.composerKey);
  if (memoryConflict && memoryConflict.recordingId !== record.recordingId) {
    return { durable: false, reason: "conflict" };
  }

  if (record.sizeBytes > MAX_PERSISTED_RECORDING_BYTES) {
    const stored = await getPendingVoiceRecording(record.composerKey);
    if (stored && stored.recordingId !== record.recordingId) {
      return { durable: false, reason: "conflict" };
    }
    memoryFallback.set(record.composerKey, cloneForMemory(record));
    return { durable: false, reason: "too-large" };
  }

  if (!getIndexedDb()) {
    memoryFallback.set(record.composerKey, cloneForMemory(record));
    return { durable: false, reason: "unavailable" };
  }

  try {
    // Read and write inside one transaction so two recordings cannot both see an empty slot.
    const conflicted = await runTransaction<boolean>("readwrite", (store, resolveValue) => {
      const read = store.get(record.composerKey);
      read.onsuccess = () => {
        const existing = read.result as PendingVoiceRecording | undefined;
        if (existing && existing.recordingId !== record.recordingId) {
          resolveValue(true);
          return;
        }
        store.put(record);
      };
      return null;
    });

    if (conflicted === true) return { durable: false, reason: "conflict" };
    memoryFallback.delete(record.composerKey);
    return { durable: true };
  } catch (error) {
    const quota = isQuotaError(error);
    markUnavailable(error);
    memoryFallback.set(record.composerKey, cloneForMemory(record));
    return { durable: false, reason: quota ? "quota" : "unavailable" };
  }
}

export async function getPendingVoiceRecording(composerKey: string): Promise<PendingVoiceRecording | null> {
  // Memory wins: it only ever holds a record that IndexedDB refused, so it is the newer copy.
  const fallback = memoryFallback.get(composerKey);
  if (fallback) return cloneForMemory(fallback);

  if (getIndexedDb()) {
    try {
      const record = await runTransaction<PendingVoiceRecording | undefined>("readonly", (store) => ({
        request: store.get(composerKey),
        read: (request) => request.result as PendingVoiceRecording | undefined,
      }));
      if (record) return record;
    } catch (error) {
      markUnavailable(error);
    }
  }

  return null;
}

export async function patchPendingVoiceRecording(
  composerKey: string,
  recordingId: string,
  patch: PendingRecordingPatch,
): Promise<void> {
  const existing = await getPendingVoiceRecording(composerKey);
  if (!existing || existing.recordingId !== recordingId) return;

  const next: PendingVoiceRecording = { ...existing, ...patch, updatedAt: Date.now() };

  if (memoryFallback.has(composerKey)) {
    memoryFallback.set(composerKey, cloneForMemory(next));
    return;
  }

  try {
    await runTransaction("readwrite", (store) => store.put(next));
  } catch (error) {
    markUnavailable(error);
    memoryFallback.set(composerKey, cloneForMemory(next));
    await dropDurableCopy(composerKey);
  }
}

/**
 * Deletes a pending recording. When `recordingId` is supplied the delete is skipped unless it still
 * owns the slot, so a late callback from a superseded recording cannot destroy a newer one.
 */
export async function deletePendingVoiceRecording(composerKey: string, recordingId?: string): Promise<void> {
  if (recordingId) {
    const existing = await getPendingVoiceRecording(composerKey);
    if (!existing || existing.recordingId !== recordingId) return;
  }

  memoryFallback.delete(composerKey);
  if (!getIndexedDb()) return;

  try {
    await runTransaction("readwrite", (store) => store.delete(composerKey));
  } catch (error) {
    markUnavailable(error);
  }
}

export async function migratePendingVoiceRecording(
  fromComposerKey: string,
  toComposerKey: string,
): Promise<PendingVoiceRecording | null> {
  if (fromComposerKey === toComposerKey) return null;

  const existing = await getPendingVoiceRecording(fromComposerKey);
  if (!existing) return null;

  const target = await getPendingVoiceRecording(toComposerKey);
  if (target && target.recordingId !== existing.recordingId) return null;

  const moved: PendingVoiceRecording = { ...existing, composerKey: toComposerKey, updatedAt: Date.now() };

  if (memoryFallback.has(fromComposerKey) || !getIndexedDb()) {
    memoryFallback.delete(fromComposerKey);
    memoryFallback.set(toComposerKey, cloneForMemory(moved));
    await dropDurableCopy(fromComposerKey);
    return moved;
  }

  try {
    await runTransaction("readwrite", (store) => {
      store.delete(fromComposerKey);
      return store.put(moved);
    });
    return moved;
  } catch (error) {
    markUnavailable(error);
    memoryFallback.set(toComposerKey, cloneForMemory(moved));
    return moved;
  }
}

/** Best-effort removal of a durable row that a memory-fallback write has superseded. */
async function dropDurableCopy(composerKey: string): Promise<void> {
  if (!getIndexedDb()) return;
  try {
    await runTransaction("readwrite", (store) => store.delete(composerKey));
  } catch (error) {
    markUnavailable(error);
  }
}

export async function listPendingVoiceRecordingKeys(): Promise<string[]> {
  const keys = new Set<string>(memoryFallback.keys());

  if (getIndexedDb()) {
    try {
      const stored = await runTransaction<string[]>("readonly", (store) => ({
        request: store.getAllKeys(),
        read: (request) => (request.result as IDBValidKey[]).map((key) => String(key)),
      }));
      for (const key of stored ?? []) keys.add(key);
    } catch (error) {
      markUnavailable(error);
    }
  }

  return [...keys];
}

export function pendingVoiceRecordingToBlob(record: PendingVoiceRecording): Blob {
  return new Blob([record.audio], { type: record.mimeType });
}

export function createVoiceRecordingId(): string {
  const cryptoRef = (globalThis as { crypto?: Crypto }).crypto;
  if (cryptoRef?.randomUUID) return cryptoRef.randomUUID();
  return `voice-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Test-only reset so suites do not leak state between files. */
export function __resetVoiceRecordingStoreForTests(): void {
  memoryFallback.clear();
  indexedDbUnavailable = false;
  dbPromise = null;
}
