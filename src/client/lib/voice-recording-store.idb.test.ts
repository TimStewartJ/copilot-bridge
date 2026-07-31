import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  __resetVoiceRecordingStoreForTests,
  deletePendingVoiceRecording,
  getPendingVoiceRecording,
  listPendingVoiceRecordingKeys,
  savePendingVoiceRecording,
} from "./voice-recording-store";

/**
 * Minimal IndexedDB stand-in. It exists to exercise the real IndexedDB code path — in particular
 * that writes resolve on transaction commit rather than on request success — without adding a
 * dependency. It only models the surface the store actually uses.
 */
interface FakeRequest {
  result: unknown;
  error: unknown;
  onsuccess: (() => void) | null;
  onerror: (() => void) | null;
}

class FakeIndexedDb {
  readonly data = new Map<string, Map<string, unknown>>();
  /** Commit is deferred by an extra macrotask so request-success and commit are observably distinct. */
  commitObserved: { requestsSettled: number; commits: number } = { requestsSettled: 0, commits: 0 };
  failNextTransaction = false;
  private writeLock: Promise<void> = Promise.resolve();

  open(_name: string, _version: number) {
    const request = {
      result: null as unknown,
      error: null as unknown,
      onsuccess: null as (() => void) | null,
      onerror: null as (() => void) | null,
      onupgradeneeded: null as (() => void) | null,
      onblocked: null as (() => void) | null,
    };

    queueMicrotask(() => {
      const db = this.createDb();
      request.result = db;
      if (!this.data.has("pending-recordings")) {
        request.onupgradeneeded?.();
      }
      request.onsuccess?.();
    });

    return request;
  }

  private createDb() {
    const owner = this;
    return {
      objectStoreNames: {
        contains: (name: string) => owner.data.has(name),
      },
      createObjectStore: (name: string) => {
        owner.data.set(name, new Map());
        return {};
      },
      onclose: null as (() => void) | null,
      transaction: (name: string, _mode: string) => owner.createTransaction(name),
    };
  }

  private createTransaction(storeName: string) {
    const owner = this;
    const shouldFail = this.failNextTransaction;
    this.failNextTransaction = false;

    const transaction = {
      error: shouldFail ? new Error("forced transaction failure") : null,
      oncomplete: null as (() => void) | null,
      onerror: null as (() => void) | null,
      onabort: null as (() => void) | null,
      aborted: false,
      abort() {
        transaction.aborted = true;
      },
      objectStore: (_name: string) => store,
    };

    const bucket = () => {
      let map = owner.data.get(storeName);
      if (!map) {
        map = new Map();
        owner.data.set(storeName, map);
      }
      return map;
    };

    const queue: Array<{ request: FakeRequest; run: () => unknown }> = [];
    let finished = false;

    const settle = () => {
      if (finished) return;
      finished = true;
      releaseLock();
      if (shouldFail || transaction.aborted) {
        transaction.onabort?.();
        return;
      }
      owner.commitObserved.commits += 1;
      transaction.oncomplete?.();
    };

    // Real IndexedDB commits once no further requests are queued, so drain then re-check.
    const drain = () => {
      const next = queue.shift();
      if (!next) {
        queueMicrotask(() => {
          if (queue.length > 0) {
            drain();
            return;
          }
          settle();
        });
        return;
      }

      queueMicrotask(() => {
        next.request.result = next.run();
        owner.commitObserved.requestsSettled += 1;
        next.request.onsuccess?.();
        drain();
      });
    };

    const enqueue = (run: () => unknown): FakeRequest => {
      const request: FakeRequest = { result: undefined, error: null, onsuccess: null, onerror: null };
      queue.push({ request, run });
      return request;
    };

    const store = {
      get: (key: string) => enqueue(() => bucket().get(key)),
      put: (value: { composerKey: string }) => enqueue(() => {
        bucket().set(value.composerKey, value);
        return value.composerKey;
      }),
      delete: (key: string) => enqueue(() => {
        bucket().delete(key);
        return undefined;
      }),
      getAllKeys: () => enqueue(() => [...bucket().keys()]),
    };

    // Overlapping readwrite transactions on the same store run one at a time, as in the spec.
    let releaseLock = () => {};
    const previous = this.writeLock;
    this.writeLock = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });

    void previous.then(drain);

    return transaction;
  }
}

describe("voice recording store on IndexedDB", () => {
  let fake: FakeIndexedDb;
  let previousIndexedDb: unknown;

  beforeEach(() => {
    fake = new FakeIndexedDb();
    previousIndexedDb = (globalThis as { indexedDB?: unknown }).indexedDB;
    (globalThis as { indexedDB?: unknown }).indexedDB = fake as unknown as IDBFactory;
    __resetVoiceRecordingStoreForTests();
  });

  afterEach(() => {
    if (previousIndexedDb === undefined) {
      delete (globalThis as { indexedDB?: unknown }).indexedDB;
    } else {
      (globalThis as { indexedDB?: unknown }).indexedDB = previousIndexedDb;
    }
    __resetVoiceRecordingStoreForTests();
  });

  it("reports a durable save and only resolves after the transaction commits", async () => {
    const result = await savePendingVoiceRecording({
      composerKey: "session-1",
      recordingId: "rec-1",
      submitMode: "autosend",
      audio: new TextEncoder().encode("hello").buffer as ArrayBuffer,
      mimeType: "audio/wav",
    });

    expect(result).toEqual({ durable: true });
    expect(fake.commitObserved.commits).toBeGreaterThan(0);
    expect(fake.data.get("pending-recordings")?.has("session-1")).toBe(true);
  });

  it("survives an app restart that drops all in-memory state", async () => {
    await savePendingVoiceRecording({
      composerKey: "session-1",
      recordingId: "rec-1",
      submitMode: "insert",
      audio: new TextEncoder().encode("hello").buffer as ArrayBuffer,
      mimeType: "audio/wav",
    });

    // Simulate a fresh page load: module caches cleared, browser storage intact.
    __resetVoiceRecordingStoreForTests();

    expect(await getPendingVoiceRecording("session-1")).toMatchObject({
      composerKey: "session-1",
      recordingId: "rec-1",
      submitMode: "insert",
    });
    expect(await listPendingVoiceRecordingKeys()).toEqual(["session-1"]);

    await deletePendingVoiceRecording("session-1", "rec-1");
    expect(await getPendingVoiceRecording("session-1")).toBeNull();
  });

  it("rejects a concurrent second recording for the same composer", async () => {
    const [first, second] = await Promise.all([
      savePendingVoiceRecording({
        composerKey: "session-1",
        recordingId: "rec-1",
        submitMode: "autosend",
        audio: new TextEncoder().encode("first").buffer as ArrayBuffer,
        mimeType: "audio/wav",
      }),
      savePendingVoiceRecording({
        composerKey: "session-1",
        recordingId: "rec-2",
        submitMode: "autosend",
        audio: new TextEncoder().encode("second").buffer as ArrayBuffer,
        mimeType: "audio/wav",
      }),
    ]);

    const outcomes = [first, second];
    expect(outcomes.filter((outcome) => outcome.durable)).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.reason === "conflict")).toHaveLength(1);
    expect(fake.data.get("pending-recordings")?.size).toBe(1);
  });

  it("falls back to memory and flags the save as non-durable when the transaction aborts", async () => {
    fake.failNextTransaction = true;

    const result = await savePendingVoiceRecording({
      composerKey: "session-1",
      recordingId: "rec-1",
      submitMode: "autosend",
      audio: new TextEncoder().encode("hello").buffer as ArrayBuffer,
      mimeType: "audio/wav",
    });

    expect(result.durable).toBe(false);
    // The recording is still retrievable so the user can retry it.
    expect(await getPendingVoiceRecording("session-1")).toMatchObject({ recordingId: "rec-1" });
  });
});
