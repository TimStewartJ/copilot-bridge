import { describe, expect, it, vi } from "vitest";
import { ApiError, type AppSettings, type AppSettingsUpdates } from "../api";
import { createSettingsWriter, describeSettingsKeys } from "./settings-writer";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A fake server, react-query cache and fetch-event channel for the writer. */
function setup(initial: Partial<AppSettings> = {}) {
  let server: AppSettings = { mcpServers: {}, theme: "dark", model: "gpt-a", ...initial };
  let cache: AppSettings | undefined = structuredClone(server);
  const listeners = new Set<(settings: AppSettings | undefined) => void>();
  const patches: AppSettingsUpdates[] = [];
  const pending: Array<Deferred<AppSettings> & { updates: AppSettingsUpdates }> = [];
  let autoRespond = true;

  const patch = vi.fn(async (updates: AppSettingsUpdates) => {
    patches.push(updates);
    if (autoRespond) {
      server = { ...server, ...updates };
      return structuredClone(server);
    }
    const request = { ...deferred<AppSettings>(), updates };
    pending.push(request);
    return request.promise;
  });
  const fetch = vi.fn(async () => structuredClone(server));
  const writer = createSettingsWriter({
    patch,
    fetch,
    readCache: () => cache,
    writeCache: (settings) => { cache = settings; },
    subscribeCache: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    now: () => 1_000,
  });

  return {
    writer,
    patch,
    fetch,
    patches,
    get cache() { return cache; },
    get server() { return server; },
    setServer(next: Partial<AppSettings>) { server = { ...server, ...next }; },
    holdResponses() { autoRespond = false; },
    /** Answer the oldest held PATCH as the server would. */
    respond() {
      const request = pending.shift();
      if (!request) throw new Error("No held request");
      server = { ...server, ...request.updates };
      request.resolve(structuredClone(server));
    },
    fail(error: unknown, { commit = false } = {}) {
      const request = pending.shift();
      if (!request) throw new Error("No held request");
      if (commit) server = { ...server, ...request.updates };
      request.reject(error);
    },
    /** A react-query fetch result, as if the settings query refetched. */
    fetched(next: Partial<AppSettings>) {
      server = { ...server, ...next };
      cache = structuredClone(server);
      for (const listener of listeners) listener(cache);
    },
  };
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("settings writer", () => {
  it("shows a change at once and sends only the keys that changed", async () => {
    const env = setup();
    env.writer.update((current) => ({ ...current, theme: "light" }));

    expect(env.writer.getSnapshot().settings?.theme).toBe("light");
    expect(env.cache?.theme).toBe("light");
    await env.writer.whenIdle();

    expect(env.patches).toEqual([{ theme: "light" }]);
    expect(env.writer.getSnapshot().status).toMatchObject({ kind: "saved", keys: ["theme"], canUndo: true });
  });

  it("sends changes made during a write together once it returns", async () => {
    const env = setup();
    env.holdResponses();
    env.writer.update((current) => ({ ...current, theme: "light" }));
    env.writer.update((current) => ({ ...current, model: "gpt-b" }));
    env.writer.update((current) => ({ ...current, favicon: "cyan" }));

    expect(env.patches).toEqual([{ theme: "light" }]);
    expect([...env.writer.getSnapshot().pendingKeys].sort()).toEqual(["favicon", "model", "theme"]);

    env.respond();
    await flush();
    expect(env.patches[1]).toEqual({ model: "gpt-b", favicon: "cyan" });
    env.respond();
    await env.writer.whenIdle();
    expect(env.writer.getSnapshot().settings).toMatchObject({ theme: "light", model: "gpt-b", favicon: "cyan" });
    expect(env.writer.getSnapshot().pendingKeys.size).toBe(0);
  });

  it("keeps a newer edit of a key that is already being saved", async () => {
    const env = setup();
    env.holdResponses();
    env.writer.update((current) => ({ ...current, model: "gpt-b" }));
    env.writer.update((current) => ({ ...current, model: "gpt-c" }));

    env.respond();
    await flush();
    expect(env.writer.getSnapshot().settings?.model).toBe("gpt-c");
    expect(env.patches[1]).toEqual({ model: "gpt-c" });
    env.respond();
    await env.writer.whenIdle();
    expect(env.server.model).toBe("gpt-c");
  });

  it("puts a rejected value back, says which setting failed, and still sends other edits", async () => {
    const env = setup();
    env.holdResponses();
    env.writer.update((current) => ({ ...current, model: "not-a-model" }));
    env.writer.update((current) => ({ ...current, theme: "light" }));

    env.fail(new ApiError("Unknown model", 400));
    await flush();

    const snapshot = env.writer.getSnapshot();
    expect(snapshot.settings?.model).toBe("gpt-a");
    expect(snapshot.failedKeys.has("model")).toBe(true);
    expect(snapshot.status).toMatchObject({ kind: "saving", keys: ["theme"] });
    env.respond();
    await env.writer.whenIdle();
    expect(env.server.theme).toBe("light");
    expect(env.patches).toEqual([{ model: "not-a-model" }, { theme: "light" }]);
  });

  it("marks a validation failure as not retryable and names the setting", async () => {
    const env = setup();
    env.holdResponses();
    env.writer.update((current) => ({ ...current, model: "not-a-model" }));
    env.fail(new ApiError("Unknown model", 400));
    await env.writer.whenIdle();

    expect(env.writer.getSnapshot().error).toEqual({
      keys: ["model"],
      message: "Couldn't save model: Unknown model",
      retryable: false,
      at: 1_000,
    });
  });

  it("asks the server what it holds after a lost response instead of assuming the write failed", async () => {
    const env = setup();
    env.holdResponses();
    env.writer.update((current) => ({ ...current, theme: "light" }));
    env.fail(new TypeError("Failed to fetch"), { commit: true });
    await env.writer.whenIdle();

    expect(env.fetch).toHaveBeenCalled();
    expect(env.writer.getSnapshot().settings?.theme).toBe("light");
    expect(env.writer.getSnapshot().error).toMatchObject({ retryable: true });
  });

  it("retries a failed write with the values the user chose", async () => {
    const env = setup();
    env.holdResponses();
    env.writer.update((current) => ({ ...current, theme: "light" }));
    env.fail(new TypeError("Failed to fetch"));
    await env.writer.whenIdle();
    expect(env.writer.getSnapshot().settings?.theme).toBe("dark");

    env.writer.retry();
    expect(env.writer.getSnapshot().settings?.theme).toBe("light");
    env.respond();
    await env.writer.whenIdle();
    expect(env.server.theme).toBe("light");
  });

  it("refreshes and sends again once after a concurrent-write conflict", async () => {
    const env = setup();
    env.holdResponses();
    env.writer.update((current) => ({ ...current, model: "gpt-b" }));
    env.fail(new ApiError("Settings changed concurrently; retry the update.", 409));
    await flush();

    expect(env.fetch).toHaveBeenCalledOnce();
    expect(env.patches).toEqual([{ model: "gpt-b" }, { model: "gpt-b" }]);
    env.respond();
    await env.writer.whenIdle();
    expect(env.writer.getSnapshot().status).toMatchObject({ kind: "saved" });
  });

  it("undoes the last save", async () => {
    const env = setup();
    env.writer.update((current) => ({ ...current, theme: "light", motion: "reduce" }));
    await env.writer.whenIdle();

    env.writer.undo();
    await env.writer.whenIdle();

    expect(env.server.theme).toBe("dark");
    expect(env.server.motion).toBeUndefined();
    expect(env.patches.at(-1)).toEqual({ theme: "dark", motion: undefined });
    expect(env.writer.getSnapshot().status).toMatchObject({ kind: "saved", canUndo: false });
  });

  it("does not undo a value that changed somewhere else since", async () => {
    const env = setup();
    env.writer.update((current) => ({ ...current, theme: "light", favicon: "cyan" }));
    await env.writer.whenIdle();
    env.fetched({ theme: "system" });

    env.writer.undo();
    await env.writer.whenIdle();

    expect(env.server.theme).toBe("system");
    expect(env.server.favicon).toBeUndefined();
    expect(env.patches.at(-1)).toEqual({ favicon: undefined });
  });

  it("adopts fetched settings when idle and ignores them while its own write is in flight", async () => {
    const env = setup();
    env.fetched({ theme: "system" });
    expect(env.writer.getSnapshot().settings?.theme).toBe("system");

    env.holdResponses();
    env.writer.update((current) => ({ ...current, model: "gpt-b" }));
    env.fetched({ favicon: "stale-read" });
    expect(env.writer.getSnapshot().settings?.model).toBe("gpt-b");
    env.respond();
    await env.writer.whenIdle();
    expect(env.writer.getSnapshot().settings?.model).toBe("gpt-b");
  });

  it("resolves patch() with the acknowledged settings", async () => {
    const env = setup();
    await expect(env.writer.patch({ helm: { spokenReasoningEffort: "low" } })).resolves.toMatchObject({
      helm: { spokenReasoningEffort: "low" },
    });
  });

  it("sends every key an explicit patch() names, even when the cache already agrees", async () => {
    const env = setup({ lastModelPreset: "preset1" });
    await env.writer.patch({ lastModelPreset: "preset1", modelPresets: { preset1: { model: "gpt-b" } } });
    expect(env.patches).toEqual([{ lastModelPreset: "preset1", modelPresets: { preset1: { model: "gpt-b" } } }]);
  });

  it("queues an explicit patch() behind a write in flight", async () => {
    const env = setup();
    env.holdResponses();
    env.writer.update((current) => ({ ...current, theme: "light" }));
    const result = env.writer.patch({ helm: { typedReasoningEffort: "high" } });
    expect(env.patches).toHaveLength(1);
    env.respond();
    await flush();
    expect(env.patches[1]).toEqual({ helm: { typedReasoningEffort: "high" } });
    env.respond();
    await expect(result).resolves.toMatchObject({ theme: "light", helm: { typedReasoningEffort: "high" } });
  });

  it("settles each queued patch() of the same key by its own write", async () => {
    const env = setup();
    env.holdResponses();
    let firstDone = false;
    let secondDone = false;
    const first = env.writer.patch({ helm: { typedReasoningEffort: "low" } }).then(() => { firstDone = true; });
    await flush();
    const second = env.writer.patch({ helm: { typedReasoningEffort: "high" } }).then(
      () => { secondDone = true; },
      (error: unknown) => { secondDone = true; throw error; },
    );

    env.respond();
    await first;
    expect(firstDone).toBe(true);
    expect(secondDone).toBe(false);

    env.fail(new ApiError("nope", 400));
    await expect(second).rejects.toThrow("nope");
  });

  it("retries only the failed values that were not changed since", async () => {
    const env = setup();
    env.holdResponses();
    env.writer.update((current) => ({ ...current, theme: "light", favicon: "cyan" }));
    env.fail(new TypeError("Failed to fetch"));
    await env.writer.whenIdle();

    env.writer.update((current) => ({ ...current, theme: "system" }));
    env.respond();
    await env.writer.whenIdle();
    expect(env.writer.getSnapshot().error?.keys).toEqual(["favicon"]);

    env.writer.retry();
    env.respond();
    await env.writer.whenIdle();
    expect(env.patches.at(-1)).toEqual({ favicon: "cyan" });
    expect(env.server).toMatchObject({ theme: "system", favicon: "cyan" });
  });

  it("clears the error when a retry finds the server already holds the values", async () => {
    const env = setup();
    env.holdResponses();
    env.writer.update((current) => ({ ...current, theme: "light" }));
    env.fail(new TypeError("Failed to fetch"), { commit: true });
    await env.writer.whenIdle();
    expect(env.writer.getSnapshot().error).not.toBeNull();

    env.writer.retry();
    expect(env.writer.getSnapshot().error).toBeNull();
    env.respond();
    await env.writer.whenIdle();
    expect(env.writer.getSnapshot().status).toMatchObject({ kind: "saved" });
  });

  it("keeps the intended settings in the cache when a fetch lands mid-write, then checks again", async () => {
    const env = setup();
    env.holdResponses();
    env.writer.update((current) => ({ ...current, model: "gpt-b" }));
    env.fetched({ favicon: "from-other-tab" });
    expect(env.cache?.model).toBe("gpt-b");

    env.respond();
    await env.writer.whenIdle();
    await flush();
    expect(env.fetch).toHaveBeenCalled();
    expect(env.writer.getSnapshot().settings).toMatchObject({ model: "gpt-b", favicon: "from-other-tab" });
  });

  it("rejects patch() when its write fails", async () => {
    const env = setup();
    env.holdResponses();
    const result = env.writer.patch({ theme: "light" });
    env.fail(new ApiError("nope", 400));
    await expect(result).rejects.toThrow("nope");
  });

  it("sends an explicit clear for a removed setting", async () => {
    const env = setup({ providers: { github: { owner: "octo" } } });
    env.writer.update((current) => ({ ...current, providers: undefined }));
    await env.writer.whenIdle();

    expect(env.patches).toEqual([{ providers: undefined }]);
    expect(Object.keys(env.patches[0]!)).toEqual(["providers"]);
  });

  it("never writes MCP servers, which have their own API", async () => {
    const env = setup();
    env.writer.update((current) => ({ ...current, mcpServers: { x: { command: "node", args: [] } } }));
    await env.writer.whenIdle();
    expect(env.patch).not.toHaveBeenCalled();
  });

  it("describes the settings a message is about in words", () => {
    expect(describeSettingsKeys(["model"])).toBe("model");
    expect(describeSettingsKeys(["model", "reasoningEffort", "contextTier"])).toBe("model, effort and context");
  });
});
