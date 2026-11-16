import { vi } from "vitest";
import { sessionsOnDisk } from "./helpers.js";

export interface MockDeferSessionManagerOptions {
  sessions?: string[];
  archivedSessions?: Set<string>;
  busySessions?: Set<string>;
  startWorkError?: Error;
  persistedUserMessage?: boolean;
  /** What a worker reports when the test supplies none: one-time triggers finish, recurring ones continue. */
  defaultAction?: "finish" | "continue";
}

/**
 * A hand-built session manager for the trigger and outbox runners. A trigger worker run, unless a test
 * sets `runDeferWorker`, records itself in `_started` and returns `defaultAction`; a message delivered
 * into a chat records itself there too, so scheduling tests can assert on what ran without caring how.
 */
export function makeMockDeferSessionManager(options: MockDeferSessionManagerOptions = {}) {
  const {
    sessions = [],
    archivedSessions = new Set(),
    busySessions = new Set(),
    startWorkError,
    persistedUserMessage = false,
    defaultAction = "finish",
  } = options;
  const started: Array<{ sessionId: string; prompt: string }> = [];
  const deliveryOptions: unknown[] = [];
  const attention: Array<{ sessionId: string; at?: string }> = [];
  const sm = {
    runDeferWorker: undefined as undefined | ((input: any) => Promise<any> | any),
    tryAcquireDeferWorker: (): { run: (input: any) => Promise<any>; release: () => void } | undefined => ({
      run: async (input: any) => {
        if (sm.runDeferWorker) return sm.runDeferWorker(input);
        if (startWorkError) throw startWorkError;
        started.push({ sessionId: input.parentSessionId, prompt: input.prompt });
        return { action: defaultAction };
      },
      release: () => {},
    }),
    readSessionsFromDisk: sessionsOnDisk(async (readOptions: { includeArchived?: boolean } = {}) =>
      sessions
        .filter((s) => readOptions.includeArchived !== false || !archivedSessions.has(s))
        .map((s) => ({ sessionId: s }))),
    isSessionBusy: (sid: string) => busySessions.has(sid),
    hasPersistedUserMessage: vi.fn(async () => persistedUserMessage),
    startWork: (sessionId: string, prompt: string) => {
      if (startWorkError) throw startWorkError;
      started.push({ sessionId, prompt });
    },
    startWorkAndWaitForDelivery: async (sessionId: string, prompt: string, _attachments?: unknown, delivery?: unknown) => {
      if (startWorkError) throw startWorkError;
      started.push({ sessionId, prompt });
      deliveryOptions.push(delivery);
    },
    markSessionAttention: (sessionId: string, at?: string) => {
      attention.push({ sessionId, at });
    },
    _started: started,
    _deliveryOptions: deliveryOptions,
    _attention: attention,
  };
  return sm;
}
