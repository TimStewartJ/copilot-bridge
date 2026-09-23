import { ApiError, type AppSettings, type AppSettingsUpdates } from "../api";
import { sameSettingValue } from "./settings-draft";

/**
 * The one path every settings write takes: Settings, Helm and model presets.
 *
 * Settings save as they change. The writer keeps the last server-acknowledged settings
 * (`confirmed`) and the user's changes that the server has not acknowledged yet (`local`). The
 * settings everyone reads, including the react-query cache, are `confirmed` with `local` on top.
 * One PATCH is in flight at a time; changes made meanwhile wait and go out together afterwards.
 *
 * Patches are per top-level key, because the server replaces structured values such as
 * `responseStyle` or `browser` whole rather than merging them.
 */

export type SettingsKey = Exclude<keyof AppSettings, "mcpServers">;

export type SettingsWriteStatus =
  | { kind: "idle" }
  | { kind: "saving"; keys: SettingsKey[] }
  | { kind: "saved"; keys: SettingsKey[]; canUndo: boolean; at: number };

/** The last write that failed. It stays until those settings are saved, changed again or retried. */
export interface SettingsWriteError {
  keys: SettingsKey[];
  message: string;
  retryable: boolean;
  at: number;
}

export interface SettingsWriterSnapshot {
  settings: AppSettings | null;
  /** Keys with a change the server has not acknowledged yet. */
  pendingKeys: ReadonlySet<SettingsKey>;
  /** Keys whose last write failed; controls use this to show the error beside themselves. */
  failedKeys: ReadonlySet<SettingsKey>;
  status: SettingsWriteStatus;
  error: SettingsWriteError | null;
}

export interface SettingsWriterDeps {
  patch: (updates: AppSettingsUpdates) => Promise<AppSettings>;
  fetch: () => Promise<AppSettings>;
  readCache: () => AppSettings | undefined;
  writeCache: (settings: AppSettings) => void;
  /** Called with the cache's settings whenever they change, including changes this writer made. */
  subscribeCache: (listener: (settings: AppSettings | undefined) => void) => () => void;
  now?: () => number;
}

interface Waiter {
  keys: SettingsKey[];
  /** The values this caller asked for; only a write that carried them settles it. */
  values: Record<string, unknown>;
  acked: Set<SettingsKey>;
  resolve: (settings: AppSettings) => void;
  reject: (error: unknown) => void;
}

export interface SettingsWriter {
  getSnapshot: () => SettingsWriterSnapshot;
  subscribe: (listener: () => void) => () => void;
  /** Apply a change to the latest settings and save it. */
  update: (recipe: (current: AppSettings) => AppSettings) => void;
  /** Save these values; resolves with the acknowledged settings, rejects if the write fails. */
  patch: (updates: AppSettingsUpdates) => Promise<AppSettings>;
  /** Put back what the last save changed, where nothing has changed those values since. */
  undo: () => void;
  /** Send the values of the last failed write again. */
  retry: () => void;
  dismissError: () => void;
  /** Resolves once nothing is waiting to be saved. */
  whenIdle: () => Promise<void>;
}

const MESSAGE_LABELS: Partial<Record<SettingsKey, string>> = {
  model: "model",
  reasoningEffort: "effort",
  contextTier: "context",
  theme: "theme",
  motion: "motion",
  favicon: "app icon",
  identity: "identity",
  responseStyle: "response style",
  customInstructions: "custom instructions",
  providers: "providers",
  computerUse: "computer use",
  deferWorker: "deferred workers",
  browser: "browser settings",
  helm: "Helm settings",
  modelPresets: "model presets",
  lastModelPreset: "model preset",
};

/** The settings a status message names, in words: "model and effort". */
export function describeSettingsKeys(keys: readonly SettingsKey[]): string {
  const labels = [...new Set(keys.map((key) => MESSAGE_LABELS[key] ?? key))];
  if (labels.length <= 1) return labels[0] ?? "settings";
  return `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function pick(settings: AppSettings, keys: readonly SettingsKey[]): AppSettingsUpdates {
  const picked: AppSettingsUpdates = {};
  for (const key of keys) (picked as Record<string, unknown>)[key] = settings[key];
  return picked;
}

export function createSettingsWriter(deps: SettingsWriterDeps): SettingsWriter {
  const now = deps.now ?? Date.now;
  let confirmed: AppSettings | null = deps.readCache() ?? null;
  const local = new Map<SettingsKey, unknown>();
  /** Keys a caller asked to write explicitly; they are sent even if the cache already agrees. */
  const forced = new Set<SettingsKey>();
  let inflight: { patch: AppSettingsUpdates; keys: SettingsKey[]; undo: boolean } | null = null;
  let undoing = false;
  let lastSaved: { keys: SettingsKey[]; before: AppSettingsUpdates; after: AppSettingsUpdates } | null = null;
  let failed: { patch: AppSettingsUpdates; keys: SettingsKey[] } | null = null;
  let status: SettingsWriteStatus = { kind: "idle" };
  let writeError: SettingsWriteError | null = null;
  let conflictRetried = false;
  let lastWritten: AppSettings | undefined;
  /** A fetch landed while a write was in flight; check the server again once the queue drains. */
  let fetchedDuringWrite = false;
  let waiters: Waiter[] = [];
  let idleWaiters: Array<() => void> = [];
  const listeners = new Set<() => void>();
  let snapshot: SettingsWriterSnapshot = buildSnapshot();

  function optimistic(): AppSettings | null {
    if (!confirmed) return null;
    if (local.size === 0) return confirmed;
    const merged = { ...confirmed } as Record<string, unknown>;
    for (const [key, value] of local) merged[key] = value;
    return merged as unknown as AppSettings;
  }

  function buildSnapshot(): SettingsWriterSnapshot {
    const pending = new Set<SettingsKey>(local.keys());
    for (const key of inflight?.keys ?? []) pending.add(key);
    return {
      settings: optimistic(),
      pendingKeys: pending,
      failedKeys: new Set(writeError?.keys ?? []),
      status,
      error: writeError,
    };
  }

  function emit() {
    const settings = optimistic();
    if (settings && settings !== deps.readCache()) {
      lastWritten = settings;
      deps.writeCache(settings);
    }
    snapshot = buildSnapshot();
    for (const listener of listeners) listener();
    if (!inflight && local.size === 0) {
      const resolvers = idleWaiters;
      idleWaiters = [];
      for (const resolve of resolvers) resolve();
    }
  }

  deps.subscribeCache((settings) => {
    if (!settings || settings === lastWritten) return;
    // A refetch or another writer. While a write of ours is in flight its response replaces this,
    // so put the intended settings back in the cache and look again once everything is sent.
    if (inflight) {
      fetchedDuringWrite = true;
      emit();
      return;
    }
    confirmed = settings;
    for (const [key, value] of local) {
      if (sameSettingValue(value, settings[key])) local.delete(key);
    }
    emit();
  });

  function clearError(keys: readonly SettingsKey[]): void {
    if (!writeError) return;
    const remaining = writeError.keys.filter((key) => !keys.includes(key));
    if (remaining.length === writeError.keys.length) return;
    if (remaining.length === 0) {
      writeError = null;
      failed = null;
    } else {
      writeError = { ...writeError, keys: remaining };
      if (failed) {
        const patch: Record<string, unknown> = {};
        for (const key of remaining) patch[key] = (failed.patch as Record<string, unknown>)[key];
        failed = { patch: patch as AppSettingsUpdates, keys: remaining };
      }
    }
  }

  function isPending(key: SettingsKey): boolean {
    return local.has(key) || Boolean(inflight?.keys.includes(key));
  }

  /**
   * Settle callers of patch(). A caller is rejected when a failed write carried its values, and
   * resolved once each of its keys was acknowledged with its value or is no longer waiting at all
   * (a later change replaced it and has settled).
   */
  function settleWaiters(write?: { patch: AppSettingsUpdates; keys: SettingsKey[]; error?: unknown }) {
    const remaining: Waiter[] = [];
    for (const waiter of waiters) {
      const carried = (key: SettingsKey) => Boolean(write?.keys.includes(key))
        && sameSettingValue((write!.patch as Record<string, unknown>)[key], waiter.values[key]);
      if (write && "error" in write && waiter.keys.some(carried)) {
        waiter.reject(write.error);
        continue;
      }
      if (write && !("error" in write)) {
        for (const key of waiter.keys) if (carried(key)) waiter.acked.add(key);
      }
      if (confirmed && waiter.keys.every((key) => waiter.acked.has(key) || !isPending(key))) {
        waiter.resolve(confirmed);
      } else {
        remaining.push(waiter);
      }
    }
    waiters = remaining;
  }

  /** Write these values even if the cache already shows them. */
  function writeExplicit(values: Record<string, unknown>): void {
    const keys = (Object.keys(values) as SettingsKey[]).filter((key) => (key as string) !== "mcpServers");
    for (const key of keys) {
      local.set(key, values[key]);
      forced.add(key);
    }
    clearError(keys);
    emit();
    flush();
  }

  async function refreshAfterDrain(): Promise<void> {
    fetchedDuringWrite = false;
    try {
      const fetched = await deps.fetch();
      if (inflight || local.size > 0) return;
      confirmed = fetched;
      emit();
    } catch {
      // The next refetch or write will bring the settings up to date.
    }
  }

  async function adoptServerSettings(): Promise<void> {
    try {
      confirmed = await deps.fetch();
    } catch {
      // Keep the last known settings; the next write or refetch will correct them.
    }
  }

  function flush(): void {
    if (inflight || !confirmed) return;
    for (const [key, value] of local) {
      if (!forced.has(key) && sameSettingValue(value, confirmed[key])) local.delete(key);
    }
    // Callers whose values already match the server have nothing to wait for.
    settleWaiters();
    if (local.size === 0) {
      emit();
      if (fetchedDuringWrite) void refreshAfterDrain();
      return;
    }

    const keys = [...local.keys()];
    const patch: AppSettingsUpdates = {};
    for (const [key, value] of local) (patch as Record<string, unknown>)[key] = value;
    inflight = { patch, keys, undo: undoing };
    undoing = false;
    for (const key of keys) forced.delete(key);
    status = { kind: "saving", keys };
    emit();
    void send(inflight);
  }

  async function send(write: NonNullable<typeof inflight>): Promise<void> {
    const before = confirmed ? pick(confirmed, write.keys) : {};
    let outcome: { patch: AppSettingsUpdates; keys: SettingsKey[]; error?: unknown };
    try {
      const response = await deps.patch(write.patch);
      conflictRetried = false;
      confirmed = response;
      for (const key of write.keys) {
        if (sameSettingValue(local.get(key), (write.patch as Record<string, unknown>)[key])) local.delete(key);
      }
      lastSaved = write.undo ? null : { keys: write.keys, before, after: pick(response, write.keys) };
      clearError(write.keys);
      status = { kind: "saved", keys: write.keys, canUndo: !write.undo, at: now() };
      outcome = { patch: write.patch, keys: write.keys };
    } catch (error) {
      if (error instanceof ApiError && error.status === 409 && !conflictRetried) {
        // Another write landed between the server's validation steps. Refresh and send again.
        conflictRetried = true;
        await adoptServerSettings();
        if (inflight === write) inflight = null;
        flush();
        return;
      }
      conflictRetried = false;
      // The response may be lost even though the server committed, so ask what it now holds
      // before deciding what to put back.
      await adoptServerSettings();
      for (const key of write.keys) {
        if (sameSettingValue(local.get(key), (write.patch as Record<string, unknown>)[key])) local.delete(key);
      }
      const rejected = error instanceof ApiError && error.status >= 400 && error.status < 500;
      failed = { patch: write.patch, keys: write.keys };
      writeError = {
        keys: write.keys,
        message: `Couldn't save ${describeSettingsKeys(write.keys)}: ${errorMessage(error)}`,
        retryable: !rejected,
        at: now(),
      };
      status = { kind: "idle" };
      outcome = { patch: write.patch, keys: write.keys, error };
    }
    if (inflight === write) inflight = null;
    settleWaiters(outcome);
    emit();
    // Changes made while this write was in flight go out next, whatever happened to it.
    flush();
  }

  /**
   * While nothing is waiting, the cache holds exactly what the writer last showed, so it is the
   * best view of the server. Reading it here also picks up a cache that was seeded or replaced
   * without a fetch.
   */
  function syncIdleFromCache(): void {
    if (inflight || local.size > 0) return;
    const cached = deps.readCache();
    if (cached) confirmed = cached;
  }

  function update(recipe: (current: AppSettings) => AppSettings): void {
    syncIdleFromCache();
    const current = optimistic();
    if (!current) return;
    const next = recipe(current);
    const keys = new Set([...Object.keys(current), ...Object.keys(next)] as SettingsKey[]);
    const changed: SettingsKey[] = [];
    for (const key of keys) {
      if ((key as string) === "mcpServers") continue;
      if (sameSettingValue(current[key], next[key])) continue;
      local.set(key, next[key]);
      changed.push(key);
    }
    if (changed.length === 0) return;
    // Changing a setting again replaces the failed attempt at it.
    clearError(changed);
    emit();
    flush();
  }

  return {
    getSnapshot() {
      // Pick up settings that reached the cache without a fetch event, such as a seeded cache.
      if (!inflight && local.size === 0) {
        const cached = deps.readCache();
        if (cached && cached !== snapshot.settings) {
          confirmed = cached;
          snapshot = buildSnapshot();
        }
      }
      return snapshot;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    update,
    async patch(updates) {
      syncIdleFromCache();
      if (!confirmed) await adoptServerSettings();
      const values = updates as Record<string, unknown>;
      const keys = (Object.keys(updates) as SettingsKey[]).filter((key) => (key as string) !== "mcpServers");
      const result = new Promise<AppSettings>((resolve, reject) => {
        waiters.push({ keys, values, acked: new Set(), resolve, reject });
      });
      // An explicit write says what the server should hold, so it is sent even when the cached
      // settings already show the same values; the cache may be behind the server.
      writeExplicit(values);
      return result;
    },
    undo() {
      if (!lastSaved || !confirmed) return;
      const saved = lastSaved;
      lastSaved = null;
      const restore: Record<string, unknown> = {};
      for (const key of saved.keys) {
        // Something else changed this since; putting the old value back would overwrite it.
        if (!sameSettingValue(confirmed[key], (saved.after as Record<string, unknown>)[key])) continue;
        restore[key] = (saved.before as Record<string, unknown>)[key];
      }
      if (Object.keys(restore).length === 0) {
        status = { kind: "idle" };
        emit();
        return;
      }
      undoing = true;
      update((current) => ({ ...current, ...restore }));
      undoing = false;
    },
    retry() {
      if (!failed) return;
      const values = failed.patch as Record<string, unknown>;
      failed = null;
      writeError = null;
      // Sent even if the server turned out to hold these values already, so the result is seen.
      writeExplicit(values);
    },
    dismissError() {
      writeError = null;
      failed = null;
      emit();
    },
    whenIdle() {
      if (!inflight && local.size === 0) return Promise.resolve();
      return new Promise((resolve) => idleWaiters.push(resolve));
    },
  };
}
