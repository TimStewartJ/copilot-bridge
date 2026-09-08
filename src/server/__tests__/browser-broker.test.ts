import { access } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BrowserBroker } from "../browser-broker.js";
import { makeTestDir } from "./helpers.js";

function successfulShutdown() {
  return {
    ok: true,
    closeOk: true,
    terminatedPids: [],
    killedPids: [],
    remainingPids: [],
    clearedRuntimeFiles: 0,
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
});

describe("browser broker", () => {
  it("creates public targets without copying or reusing the authenticated profile", async () => {
    const root = makeTestDir("browser-broker-public");
    const broker = new BrowserBroker({
      copilotHome: root,
      getBrowserLaunchConfig: () => ({
        masterProfileDirectory: join(root, "authenticated-profile"),
      }),
      shutdownTarget: vi.fn(async () => successfulShutdown()),
    });

    const lease = await broker.createSessionTarget("public");

    expect(lease.context).toBe("public");
    expect(lease.browserTarget.profileDir).toContain(join(root, "browser-public"));
    expect(lease.browserTarget.profileDir).not.toContain("authenticated-profile");
    expect(lease.browserTarget.sessionName).toContain("copilot-bridge-public-");
    await broker.disposeSessionTarget(lease, {
      toolName: "test",
      browserOpId: "op-public",
    });
  });

  it("serializes authenticated operations", async () => {
    const root = makeTestDir("browser-broker-auth");
    const broker = new BrowserBroker({ copilotHome: root });
    const order: string[] = [];
    let releaseFirst!: () => void;

    const first = broker.withEphemeralContext("authenticated", {
      toolName: "test",
      browserOpId: "op-1",
      skipReadiness: true,
    }, async () => {
      order.push("first-start");
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      order.push("first-end");
    });
    const second = broker.withEphemeralContext("authenticated", {
      toolName: "test",
      browserOpId: "op-2",
      skipReadiness: true,
    }, async () => {
      order.push("second");
    });

    await vi.waitFor(() => expect(order).toEqual(["first-start"]));
    releaseFirst();
    await Promise.all([first, second]);

    expect(order).toEqual(["first-start", "first-end", "second"]);
  });

  it("bounds concurrent public operations without sharing profile directories", async () => {
    const root = makeTestDir("browser-broker-concurrency");
    const broker = new BrowserBroker({
      copilotHome: root,
      publicConcurrency: 1,
      shutdownTarget: vi.fn(async () => successfulShutdown()),
    });
    const profiles: string[] = [];
    let releaseFirst!: () => void;
    let markFirstEntered!: () => void;
    const firstEntered = new Promise<void>((resolve) => {
      markFirstEntered = resolve;
    });

    const first = broker.withEphemeralContext("public", {
      toolName: "test",
      browserOpId: "public-1",
      skipReadiness: true,
    }, async (lease) => {
      profiles.push(lease.browserTarget.profileDir);
      markFirstEntered();
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
    });
    await firstEntered;
    const second = broker.withEphemeralContext("public", {
      toolName: "test",
      browserOpId: "public-2",
      skipReadiness: true,
    }, async (lease) => {
      profiles.push(lease.browserTarget.profileDir);
    });

    await vi.waitFor(() => expect(broker.getSnapshot().public.queuedOperations).toBe(1));
    expect(profiles).toHaveLength(1);
    releaseFirst();
    await Promise.all([first, second]);

    expect(profiles).toHaveLength(2);
    expect(new Set(profiles).size).toBe(2);
  });

  it("serializes operations that share one public session target", async () => {
    const root = makeTestDir("browser-broker-public-session");
    const broker = new BrowserBroker({
      copilotHome: root,
      publicConcurrency: 2,
      shutdownTarget: vi.fn(async () => successfulShutdown()),
    });
    const lease = await broker.createSessionTarget("public");
    const order: string[] = [];
    let releaseFirst!: () => void;
    let markFirstEntered!: () => void;
    const firstEntered = new Promise<void>((resolve) => {
      markFirstEntered = resolve;
    });

    const first = broker.withTarget(lease, {
      toolName: "test",
      browserOpId: "same-public-1",
      skipReadiness: true,
    }, async () => {
      order.push("first-enter");
      markFirstEntered();
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      order.push("first-exit");
    });
    await firstEntered;
    const second = broker.withTarget(lease, {
      toolName: "test",
      browserOpId: "same-public-2",
      skipReadiness: true,
    }, async () => {
      order.push("second-enter");
    });

    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(order).toEqual(["first-enter"]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(["first-enter", "first-exit", "second-enter"]);
    await broker.disposeSessionTarget(lease, {
      toolName: "test",
      browserOpId: "same-public-close",
    });
  });

  it("requires two successful commands before reporting readiness", async () => {
    const root = makeTestDir("browser-broker-readiness");
    const runCommand = vi.fn()
      .mockResolvedValueOnce({ ok: false, output: "connection refused" })
      .mockResolvedValueOnce({ ok: true, output: "about:blank" })
      .mockResolvedValueOnce({ ok: true, output: "" });
    const broker = new BrowserBroker({
      copilotHome: root,
      runCommand,
    });

    await broker.withEphemeralContext("authenticated", {
      toolName: "test",
      browserOpId: "readiness",
    }, async () => undefined);

    expect(runCommand).toHaveBeenCalledTimes(3);
    expect(broker.getSnapshot().authenticated).toMatchObject({
      status: "ready",
      activeOperations: 0,
      queuedOperations: 0,
    });
  });

  it("records an unavailable state when readiness never succeeds", async () => {
    const root = makeTestDir("browser-broker-unavailable");
    const broker = new BrowserBroker({
      copilotHome: root,
      runCommand: vi.fn(async () => ({ ok: false, output: "connection refused" })),
    });

    await expect(broker.withEphemeralContext("authenticated", {
      toolName: "test",
      browserOpId: "readiness-failed",
    }, async () => undefined)).rejects.toThrow("Browser authenticated context is unavailable");

    expect(broker.getSnapshot().authenticated).toMatchObject({
      status: "unavailable",
      lastError: expect.stringContaining("unavailable"),
    });
  });

  it("does not treat a skip-readiness launch as a completed functional probe", async () => {
    const root = makeTestDir("browser-broker-unverified-launch");
    const broker = new BrowserBroker({ copilotHome: root });

    await broker.withEphemeralContext("authenticated", {
      toolName: "test",
      browserOpId: "unverified-launch",
      skipReadiness: true,
    }, async () => undefined);

    const snapshot = broker.getSnapshot().authenticated;
    expect(snapshot.status).toBe("starting");
    expect(snapshot).not.toHaveProperty("lastProbeAt");
  });

  it("drains active authenticated work, rejects queued work, then shuts down", async () => {
    const root = makeTestDir("browser-broker-shutdown");
    const order: string[] = [];
    const broker = new BrowserBroker({
      copilotHome: root,
      shutdownTarget: vi.fn(async () => {
        order.push("shutdown");
        return successfulShutdown();
      }),
    });
    let releaseFirst!: () => void;
    let markFirstEntered!: () => void;
    const firstEntered = new Promise<void>((resolve) => {
      markFirstEntered = resolve;
    });
    const first = broker.withEphemeralContext("authenticated", {
      toolName: "test",
      browserOpId: "auth-active",
      skipReadiness: true,
    }, async () => {
      order.push("operation-enter");
      markFirstEntered();
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      order.push("operation-exit");
    });
    await firstEntered;
    const queued = broker.withEphemeralContext("authenticated", {
      toolName: "test",
      browserOpId: "auth-queued",
      skipReadiness: true,
    }, async () => {
      order.push("queued-enter");
    });
    const shutdown = broker.shutdownAuthenticated();

    releaseFirst();
    await first;
    await expect(queued).rejects.toThrow("Authenticated browser is closing");
    await expect(shutdown).resolves.toMatchObject({ ok: true });
    expect(order).toEqual(["operation-enter", "operation-exit", "shutdown"]);
  });

  it("removes a public profile even when browser shutdown rejects", async () => {
    const root = makeTestDir("browser-broker-cleanup-rejection");
    const broker = new BrowserBroker({
      copilotHome: root,
      shutdownTarget: vi.fn(async () => {
        throw new Error("shutdown failed");
      }),
    });
    const lease = await broker.createSessionTarget("public");

    await expect(broker.disposeSessionTarget(lease, {
      toolName: "test",
      browserOpId: "cleanup-rejection",
    })).rejects.toThrow("shutdown failed");
    await expect(access(lease.browserTarget.profileDir)).rejects.toThrow();
  });
});
