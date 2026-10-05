import { access, mkdir, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  browserFailureAdvice,
  type BrowserLaunchConfig,
  type BrowserShutdownResult,
  type BrowserTarget,
} from "../agent-browser.js";
import {
  BROWSER_SESSION_IDLE_TIMEOUT_MS,
  BrowserBroker,
  BrowserUnavailableError,
  PUBLIC_BROWSER_DAEMON_IDLE_TIMEOUT_MS,
  type BrowserBrokerLease,
  type BrowserBrokerOptions,
} from "../browser-broker.js";
import type { TelemetryStore } from "../telemetry-store.js";
import { makeTestDir } from "./helpers.js";
import { testExecutablePath } from "./test-paths.js";

type RunCommand = NonNullable<BrowserBrokerOptions["runCommand"]>;
type ShutdownTarget = NonNullable<BrowserBrokerOptions["shutdownTarget"]>;
type RemoveProfile = NonNullable<BrowserBrokerOptions["removeProfile"]>;

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
/** The broker's MAX_PUBLIC_SLOTS. */
const MAX_PUBLIC_SLOTS = 32;
const OP = { toolName: "test", browserOpId: "op" };
/** An operation that does not ask the browser whether it is ready first. */
const QUIET = { ...OP, skipReadiness: true };

function successfulShutdown(): BrowserShutdownResult {
  return {
    ok: true,
    closeOk: true,
    terminatedPids: [],
    killedPids: [],
    remainingPids: [],
    clearedRuntimeFiles: 0,
  };
}

/** A shutdown after which browser processes of the profile are still running. */
function shutdownLeaving(...remainingPids: number[]): BrowserShutdownResult {
  return {
    ...successfulShutdown(),
    ok: false,
    failureCode: "profile_processes_remaining",
    remainingPids,
  };
}

function publicRoot(copilotHome: string): string {
  return join(copilotHome, "browser-public");
}

function slotDir(copilotHome: string, slot: number): string {
  return join(publicRoot(copilotHome), `slot-${slot}`);
}

/** The slot a public target belongs to, from the number its session name ends with. */
function slotOf(target: BrowserTarget): number {
  return Number(target.sessionName.slice(target.sessionName.lastIndexOf("-") + 1));
}

/** A shutdown that closes every browser, or what `outcome` says for the given slot. */
function mockShutdown(outcome: (slot: number) => BrowserShutdownResult = () => successfulShutdown()) {
  return vi.fn<ShutdownTarget>(async (target) => outcome(slotOf(target)));
}

/** The slots whose browser was shut down, in order. */
function closedSlots(shutdownTarget: ReturnType<typeof mockShutdown>): number[] {
  return shutdownTarget.mock.calls.map(([target]) => slotOf(target));
}

/** A browser that answers its readiness commands while `starts()` says so. */
function mockBrowser(starts: () => boolean = () => true, failureOutput = "Chrome exited early") {
  return vi.fn<RunCommand>(async () => (starts()
    ? { ok: true, output: "about:blank" }
    : { ok: false, output: failureOutput }));
}

/** Removes the directory for real, as the process host does in production. */
function mockRemoveProfile() {
  return vi.fn<RemoveProfile>((profileDir) => rm(profileDir, { recursive: true, force: true }));
}

/** Collects what the broker records, by span name. */
function spanRecorder() {
  const recordSpan = vi.fn();
  return {
    telemetryStore: { recordSpan } as unknown as TelemetryStore,
    spansNamed: (name: string): unknown[] =>
      recordSpan.mock.calls.flatMap(([span]) => (span.name === name ? [span.metadata] : [])),
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** A folder under the public profile root that was last changed `ageMs` before now. */
async function makeAgedDirectory(copilotHome: string, name: string, ageMs: number): Promise<string> {
  const directory = join(publicRoot(copilotHome), name);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "Preferences"), "{}");
  await setAge(directory, ageMs);
  return directory;
}

async function setAge(path: string, ageMs: number): Promise<void> {
  const changedAt = new Date(Date.now() - ageMs);
  await utimes(path, changedAt, changedAt);
}

/**
 * Readiness waits between its attempts, and the removal of a profile between its own, on real
 * timers. This runs an operation whose browser does not come up without those waits: only the
 * timers are faked, the file system stays real, and every round lets both make progress until
 * the operation has settled.
 */
async function withoutReadinessWaits<T>(operation: () => Promise<T>): Promise<T> {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    let settled = false;
    const outcome = operation().finally(() => {
      settled = true;
    });
    outcome.catch(() => undefined);
    while (!settled) {
      await vi.advanceTimersByTimeAsync(2_000);
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    return await outcome;
  } finally {
    vi.useRealTimers();
  }
}

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("browser broker", () => {
  it("gives a public browser a profile and a daemon of its own, apart from the authenticated browser's", async () => {
    const root = makeTestDir("browser-broker-public");
    const broker = new BrowserBroker({
      copilotHome: root,
      getBrowserLaunchConfig: () => ({ masterProfileDirectory: join(root, "authenticated-profile") }),
      shutdownTarget: mockShutdown(),
    });

    const lease = await broker.createSessionTarget("public");
    const authenticated = await broker.createSessionTarget("authenticated");

    expect(lease).toEqual({
      context: "public",
      publicSlot: 1,
      publicProfileIsNew: true,
      browserTarget: {
        sessionName: expect.stringMatching(/^copilot-bridge-public-[a-f0-9]{8}-1$/),
        profileDir: slotDir(root, 1),
        // Its daemon outlives an idle browser_session handle, and goes away with the browser when one is lost.
        idleTimeoutMs: PUBLIC_BROWSER_DAEMON_IDLE_TIMEOUT_MS,
        stopDaemonOnShutdown: true,
      },
    });
    expect(PUBLIC_BROWSER_DAEMON_IDLE_TIMEOUT_MS).toBeGreaterThan(BROWSER_SESSION_IDLE_TIMEOUT_MS);
    expect(authenticated).toEqual({ context: "authenticated", browserTarget: broker.getAuthenticatedTarget() });
    expect(authenticated.browserTarget.profileDir).toBe(join(root, "authenticated-profile"));
    expect(authenticated.browserTarget.sessionName).not.toBe(lease.browserTarget.sessionName);
    expect(authenticated.browserTarget).not.toHaveProperty("stopDaemonOnShutdown");
    expect(authenticated.browserTarget).not.toHaveProperty("idleTimeoutMs");
  });

  it("serializes authenticated operations", async () => {
    const root = makeTestDir("browser-broker-auth");
    const broker = new BrowserBroker({ copilotHome: root });
    const order: string[] = [];
    let releaseFirst!: () => void;

    const first = broker.withEphemeralContext("authenticated", QUIET, async () => {
      order.push("first-start");
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      order.push("first-end");
    });
    const second = broker.withEphemeralContext("authenticated", QUIET, async () => {
      order.push("second");
    });

    await vi.waitFor(() => expect(order).toEqual(["first-start"]));
    releaseFirst();
    await Promise.all([first, second]);

    expect(order).toEqual(["first-start", "first-end", "second"]);
  });

  it("bounds concurrent public operations, each on a profile of its own, and holds none for one that waits", async () => {
    const root = makeTestDir("browser-broker-concurrency");
    const broker = new BrowserBroker({
      copilotHome: root,
      publicConcurrency: 2,
      shutdownTarget: vi.fn(async () => successfulShutdown()),
    });
    /** An operation that stays in its browser until `finish` lets it go. */
    const occupy = (browserOpId: string) => {
      const occupied = { slot: undefined as number | undefined, finish: () => undefined as void };
      let markEntered!: () => void;
      const entered = new Promise<void>((resolve) => {
        markEntered = resolve;
      });
      const done = broker.withEphemeralContext("public", {
        toolName: "test",
        browserOpId,
        skipReadiness: true,
      }, async (lease) => {
        occupied.slot = lease.publicSlot;
        markEntered();
        await new Promise<void>((resolve) => {
          occupied.finish = resolve;
        });
      });
      return Object.assign(occupied, { entered, done });
    };

    const first = occupy("public-1");
    const second = occupy("public-2");
    await Promise.all([first.entered, second.entered]);
    const third = occupy("public-3");

    expect(broker.getSnapshot().public).toMatchObject({ activeOperations: 2, queuedOperations: 1 });
    expect([first.slot, second.slot].sort()).toEqual([1, 2]);
    // The one that waits its turn has no profile yet.
    expect(third.slot).toBeUndefined();
    await expect(broker.getPublicProfileStats()).resolves.toEqual({ profiles: 2, inUse: 2 });

    first.finish();
    await first.done;
    await third.entered;
    // It takes the profile that came free and not a third one.
    expect(third.slot).toBe(first.slot);
    expect(broker.getSnapshot().public).toMatchObject({ activeOperations: 2, queuedOperations: 0 });
    second.finish();
    third.finish();
    await Promise.all([second.done, third.done]);

    expect(broker.getSnapshot().public).toMatchObject({ activeOperations: 0, queuedOperations: 0 });
    await expect(broker.getPublicProfileStats()).resolves.toEqual({ profiles: 2, inUse: 0 });
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

    const first = broker.withTarget(lease, QUIET, async () => {
      order.push("first-enter");
      markFirstEntered();
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      order.push("first-exit");
    });
    await firstEntered;
    const second = broker.withTarget(lease, QUIET, async () => {
      order.push("second-enter");
    });

    // Nothing but promise callbacks stands between the second operation and the target; one
    // turn of the event loop runs them all, so it would have entered by now if it could.
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(order).toEqual(["first-enter"]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(["first-enter", "first-exit", "second-enter"]);
    await broker.disposeSessionTarget(lease, OP);
  });

  it("requires two successful commands before reporting readiness", async () => {
    const root = makeTestDir("browser-broker-readiness");
    const runCommand = vi.fn()
      .mockResolvedValueOnce({ ok: false, output: "connection refused" })
      .mockResolvedValueOnce({ ok: true, output: "about:blank" })
      .mockResolvedValueOnce({ ok: true, output: "" });
    const { telemetryStore, spansNamed } = spanRecorder();
    const broker = new BrowserBroker({ copilotHome: root, runCommand, telemetryStore });

    await broker.withEphemeralContext("authenticated", OP, async () => undefined);

    expect(runCommand).toHaveBeenCalledTimes(3);
    expect(broker.getSnapshot().authenticated).toMatchObject({
      status: "ready",
      activeOperations: 0,
      queuedOperations: 0,
    });
    expect(spansNamed("browser.broker.readiness")).toEqual([expect.objectContaining({ success: true })]);
  });

  it("records an unavailable state when readiness never succeeds", async () => {
    const root = makeTestDir("browser-broker-unavailable");
    const { telemetryStore, spansNamed } = spanRecorder();
    const broker = new BrowserBroker({
      copilotHome: root,
      runCommand: vi.fn(async () => ({ ok: false, output: "connection refused" })),
      telemetryStore,
    });

    const failure = await withoutReadinessWaits(() => broker.withEphemeralContext("authenticated", OP, async () => undefined))
      .catch((error: unknown) => error);

    // Its own kind of error: the browser did not start, which says nothing about a page.
    expect(failure).toBeInstanceOf(BrowserUnavailableError);
    expect(failure).toMatchObject({
      name: "BrowserUnavailableError",
      message: "Browser authenticated context is unavailable: connection refused",
    });
    expect(broker.getSnapshot().authenticated).toMatchObject({
      status: "unavailable",
      lastError: expect.stringContaining("unavailable"),
    });
    // Diagnostics counts these.
    expect(spansNamed("browser.broker.readiness"))
      .toEqual([expect.objectContaining({ success: false, browserContext: "authenticated" })]);
  });

  it("says that the handshake did not complete when the browser gave no reason", async () => {
    const root = makeTestDir("browser-broker-unavailable-silent");
    const broker = new BrowserBroker({
      copilotHome: root,
      runCommand: vi.fn(async () => ({ ok: false, output: " \n" })),
    });

    await expect(
      withoutReadinessWaits(() => broker.withEphemeralContext("authenticated", OP, async () => undefined)),
    ).rejects.toThrow(
      "Browser authenticated context is unavailable: agent-browser did not complete the readiness handshake",
    );
  });

  it("does not treat a skip-readiness launch as a completed functional probe", async () => {
    const root = makeTestDir("browser-broker-unverified-launch");
    const broker = new BrowserBroker({ copilotHome: root });

    await broker.withEphemeralContext("authenticated", QUIET, async () => undefined);

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
    const first = broker.withEphemeralContext("authenticated", QUIET, async () => {
      order.push("operation-enter");
      markFirstEntered();
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      order.push("operation-exit");
    });
    await firstEntered;
    const queued = broker.withEphemeralContext("authenticated", QUIET, async () => {
      order.push("queued-enter");
    });
    const shutdown = broker.shutdownAuthenticated();

    releaseFirst();
    await first;
    await expect(queued).rejects.toThrow("Authenticated browser is closing");
    await expect(shutdown).resolves.toMatchObject({ ok: true });
    expect(order).toEqual(["operation-enter", "operation-exit", "shutdown"]);
  });

  it("keeps the outcome of a public operation when the cleanup after it fails", async () => {
    const root = makeTestDir("browser-broker-cleanup-after-operation");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const removeProfile = mockRemoveProfile();
    const shutdownTarget = mockShutdown();
    const broker = new BrowserBroker({ copilotHome: root, shutdownTarget, removeProfile });

    // The check before the profile's first use passes; closing the browser afterwards throws.
    shutdownTarget
      .mockResolvedValueOnce(successfulShutdown())
      .mockRejectedValueOnce(new Error("shutdown failed"));
    await expect(broker.withEphemeralContext("public", QUIET, async () => "the page")).resolves.toBe("the page");

    // The profile is checked again, and this time the browser's processes outlive the shutdown.
    shutdownTarget
      .mockResolvedValueOnce(successfulShutdown())
      .mockResolvedValueOnce(shutdownLeaving(77, 78));
    await expect(broker.withEphemeralContext("public", QUIET, async () => {
      throw new Error("the page did not load");
    })).rejects.toThrow("the page did not load");

    // The profile was not removed and is not left held: the cleanup's failure is logged, not thrown.
    expect(removeProfile).not.toHaveBeenCalled();
    await expect(broker.getPublicProfileStats()).resolves.toEqual({ profiles: 1, inUse: 0 });
  });

  it("gives its place back when no profile could be leased for a public operation", async () => {
    const root = makeTestDir("browser-broker-lease-fails");
    const shutdownTarget = mockShutdown();
    shutdownTarget.mockRejectedValueOnce(new Error("process list unavailable"));
    const broker = new BrowserBroker({ copilotHome: root, publicConcurrency: 1, shutdownTarget });
    const operation = vi.fn(async (lease: BrowserBrokerLease) => lease.publicSlot);

    await expect(broker.withEphemeralContext("public", QUIET, operation))
      .rejects.toThrow("process list unavailable");

    expect(operation).not.toHaveBeenCalled();
    await expect(broker.getPublicProfileStats()).resolves.toEqual({ profiles: 0, inUse: 0 });
    // With one place only, the next operation would wait for good had it not come back.
    await expect(broker.withEphemeralContext("public", QUIET, operation)).resolves.toBe(1);
    expect(broker.getSnapshot().public).toMatchObject({ activeOperations: 0, queuedOperations: 0 });
  });

  it("tells what to do when the host refuses the browser its sandbox", async () => {
    const root = makeTestDir("browser-broker-no-sandbox");
    const output = "Chrome exited early without writing DevToolsActivePort\n"
      + "No usable sandbox! If you are running on Ubuntu 23.10+ or another Linux distro that has disabled "
      + "unprivileged user namespaces with AppArmor, see the Chromium sandbox documentation.";
    const advice = browserFailureAdvice(output);
    const broker = new BrowserBroker({
      copilotHome: root,
      runCommand: mockBrowser(() => false, output),
      shutdownTarget: mockShutdown(),
    });
    const operation = vi.fn(async () => undefined);

    expect(advice).toEqual(expect.stringContaining("--no-sandbox"));
    await expect(withoutReadinessWaits(() => broker.withEphemeralContext("public", OP, operation)))
      .rejects.toThrow(`Browser public context is unavailable: ${advice}`);

    expect(operation).not.toHaveBeenCalled();
    const health = broker.getSnapshot().public;
    expect(health.status).toBe("unavailable");
    expect(health.lastError).toContain(advice);
    // The advice stands in for the raw output, which names a symptom and not the cause.
    expect(health.lastError).not.toContain("DevToolsActivePort");

    const probed = await withoutReadinessWaits(() => broker.probe("authenticated"));
    expect(probed.status).toBe("unavailable");
    expect(probed.lastError).toContain(advice);
  });

  it("probes a context in a browser of its own, runs what it is given in that browser, and reports the health either way", async () => {
    const root = makeTestDir("browser-broker-probe");
    const shutdownTarget = mockShutdown();
    const broker = new BrowserBroker({ copilotHome: root, runCommand: mockBrowser(), shutdownTarget });
    const seen: Array<{ lease: BrowserBrokerLease; inUse: number }> = [];
    const inBrowser = vi.fn(async (lease: BrowserBrokerLease) => {
      seen.push({ lease, inUse: (await broker.getPublicProfileStats()).inUse });
    });

    await expect(broker.probe("public", inBrowser)).resolves.toMatchObject({ context: "public", status: "ready" });

    // It ran once the browser was up, on the profile the probe held, and the browser was closed after it.
    expect(seen).toEqual([{ lease: expect.objectContaining({ context: "public", publicSlot: 1 }), inUse: 1 }]);
    expect(shutdownTarget).toHaveBeenLastCalledWith(seen[0].lease.browserTarget, undefined);
    await expect(broker.getPublicProfileStats()).resolves.toEqual({ profiles: 1, inUse: 0 });

    // What it throws is the probe's finding, not the probe's failure.
    inBrowser.mockRejectedValueOnce(new Error("the stream sent no picture"));
    const health = await broker.probe("public", inBrowser);
    expect(health).toMatchObject({ context: "public", status: "degraded", lastError: "the stream sent no picture" });
    await expect(broker.getPublicProfileStats()).resolves.toEqual({ profiles: 1, inUse: 0 });

    // Without one, it only starts the browser.
    await expect(broker.probe("public")).resolves.toMatchObject({ status: "ready" });
    await expect(broker.probe("authenticated", async (lease) => {
      seen.push({ lease, inUse: 0 });
    })).resolves.toMatchObject({ context: "authenticated", status: "ready" });
    expect(seen.at(-1)?.lease).toEqual({ context: "authenticated", browserTarget: broker.getAuthenticatedTarget() });
  });
});

describe("public browser targets", () => {

  it("gives another Bridge on the host other session names and keeps its own across restarts", async () => {
    const root = makeTestDir("browser-broker-instance-a");
    const otherRoot = makeTestDir("browser-broker-instance-b");
    const sessionNameOf = async (copilotHome: string) => {
      const broker = new BrowserBroker({ copilotHome, shutdownTarget: mockShutdown() });
      const lease = await broker.createSessionTarget("public");
      expect(lease.publicSlot).toBe(1);
      return lease.browserTarget.sessionName;
    };

    const name = await sessionNameOf(root);
    const nameAfterRestart = await sessionNameOf(root);
    const otherName = await sessionNameOf(otherRoot);

    expect(nameAfterRestart).toBe(name);
    expect(otherName).not.toBe(name);
    expect(otherName).toMatch(/^copilot-bridge-public-[a-f0-9]{8}-1$/);
  });

  it("tells the holder of a lease whether its profile folder was made for it", async () => {
    const root = makeTestDir("browser-broker-public-profile-is-new");
    await mkdir(slotDir(root, 2), { recursive: true });
    const broker = new BrowserBroker({ copilotHome: root, shutdownTarget: mockShutdown() });

    const first = await broker.createSessionTarget("public");
    const leftFromEarlier = await broker.createSessionTarget("public");
    await broker.disposeSessionTarget(first, OP);
    const again = await broker.createSessionTarget("public");
    const neverUsed = await broker.createSessionTarget("public", { unused: true });

    expect(first).toMatchObject({ publicSlot: 1, publicProfileIsNew: true });
    expect(leftFromEarlier).toMatchObject({ publicSlot: 2, publicProfileIsNew: false });
    expect(again).toMatchObject({ publicSlot: 1, publicProfileIsNew: false });
    expect(neverUsed).toMatchObject({ publicSlot: 3, publicProfileIsNew: true });
    expect(await broker.createSessionTarget("authenticated")).not.toHaveProperty("publicProfileIsNew");
  });

  it("takes the window and the executable of a public browser from the launch configuration", async () => {
    const root = makeTestDir("browser-broker-public-launch-config");
    const executablePath = testExecutablePath("chrome");
    let launchConfig: BrowserLaunchConfig = {};
    const broker = new BrowserBroker({
      copilotHome: root,
      getBrowserLaunchConfig: () => launchConfig,
      shutdownTarget: mockShutdown(),
    });

    // A window and an executable only when the launch configuration asks for them.
    const plain = await broker.createSessionTarget("public");
    // The configuration is read for each lease, so a change in Settings needs no restart.
    launchConfig = { headed: true, executablePath, masterProfileDirectory: join(root, "authenticated-profile") };
    const configured = await broker.createSessionTarget("public");

    expect(plain.browserTarget).not.toHaveProperty("headed");
    expect(plain.browserTarget).not.toHaveProperty("executablePath");
    expect(configured.browserTarget).toEqual({
      sessionName: plain.browserTarget.sessionName.replace(/-1$/, "-2"),
      profileDir: slotDir(root, 2),
      idleTimeoutMs: PUBLIC_BROWSER_DAEMON_IDLE_TIMEOUT_MS,
      stopDaemonOnShutdown: true,
      headed: true,
      executablePath,
    });
  });
});

describe("public profile slots", () => {
  it("uses the same profile for one operation after another and keeps what the browser left in it", async () => {
    const root = makeTestDir("browser-broker-slot-reuse");
    const events: string[] = [];
    const shutdownTarget = vi.fn<ShutdownTarget>(async (target) => {
      events.push(`close ${slotOf(target)}`);
      return successfulShutdown();
    });
    const removeProfile = mockRemoveProfile();
    const broker = new BrowserBroker({ copilotHome: root, shutdownTarget, removeProfile });
    const leases: BrowserBrokerLease[] = [];

    await broker.withEphemeralContext("public", QUIET, async (lease) => {
      events.push("first operation");
      leases.push(lease);
      await writeFile(join(lease.browserTarget.profileDir, "Cookies"), "left by the first");
    });
    const found = await broker.withEphemeralContext("public", QUIET, async (lease) => {
      events.push("second operation");
      leases.push(lease);
      return readFile(join(lease.browserTarget.profileDir, "Cookies"), "utf-8");
    });

    expect(leases.map((lease) => lease.publicSlot)).toEqual([1, 1]);
    expect(leases[1].browserTarget).toEqual(leases[0].browserTarget);
    expect(leases[0].browserTarget.profileDir).toBe(slotDir(root, 1));
    expect(found).toBe("left by the first");
    // Checked for a leftover browser once, then closed after each operation.
    expect(events).toEqual(["close 1", "first operation", "close 1", "second operation", "close 1"]);
    expect(await readdir(publicRoot(root))).toEqual(["slot-1"]);
    expect(removeProfile).not.toHaveBeenCalled();
  });

  it("gives browsers that are open at the same time profiles of their own, lowest free first", async () => {
    const root = makeTestDir("browser-broker-slot-distinct");
    const broker = new BrowserBroker({ copilotHome: root, shutdownTarget: mockShutdown() });

    const first = await broker.createSessionTarget("public");
    const second = await broker.createSessionTarget("public");

    expect([first.publicSlot, second.publicSlot]).toEqual([1, 2]);
    expect(second.browserTarget.sessionName).not.toBe(first.browserTarget.sessionName);
    expect(second.browserTarget.profileDir).not.toBe(first.browserTarget.profileDir);
    expect(await exists(first.browserTarget.profileDir)).toBe(true);
    expect(await exists(second.browserTarget.profileDir)).toBe(true);

    await expect(broker.disposeSessionTarget(first, OP)).resolves.toBeUndefined();
    const third = await broker.createSessionTarget("public");
    const fourth = await broker.createSessionTarget("public");

    // The first profile is free again while the second is still held.
    expect(third.publicSlot).toBe(1);
    expect(third.browserTarget).toEqual(first.browserTarget);
    expect(fourth.publicSlot).toBe(3);
  });

  it("never hands one profile to two leases that are requested together", async () => {
    const root = makeTestDir("browser-broker-slot-together");
    const broker = new BrowserBroker({ copilotHome: root, shutdownTarget: mockShutdown() });

    const leases = await Promise.all(Array.from({ length: 6 }, () => broker.createSessionTarget("public")));

    expect(leases.map((lease) => lease.publicSlot).sort((a, b) => a! - b!)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(new Set(leases.map((lease) => lease.browserTarget.sessionName)).size).toBe(6);
    expect(new Set(leases.map((lease) => lease.browserTarget.profileDir)).size).toBe(6);
    await expect(broker.getPublicProfileStats()).resolves.toEqual({ profiles: 6, inUse: 6 });
  });

  it("checks a profile for a leftover browser once, before its first use", async () => {
    const root = makeTestDir("browser-broker-slot-verify-once");
    const shutdownTarget = mockShutdown();
    const broker = new BrowserBroker({ copilotHome: root, shutdownTarget });

    const first = await broker.createSessionTarget("public");
    expect(shutdownTarget.mock.calls).toEqual([[first.browserTarget, undefined]]);

    await broker.disposeSessionTarget(first, OP);
    expect(closedSlots(shutdownTarget)).toEqual([1, 1]);

    // Closed cleanly, so the second lease of the profile needs no check.
    const again = await broker.createSessionTarget("public");
    expect(again.publicSlot).toBe(1);
    expect(closedSlots(shutdownTarget)).toEqual([1, 1]);

    // Another profile is checked before its own first use.
    const other = await broker.createSessionTarget("public");
    expect(other.publicSlot).toBe(2);
    expect(closedSlots(shutdownTarget)).toEqual([1, 1, 2]);
  });

  it("skips a profile whose leftover browser will not die and tries it again for the next lease", async () => {
    const root = makeTestDir("browser-broker-slot-stuck");
    let stuck = true;
    const shutdownTarget = mockShutdown((slot) => (slot === 1 && stuck ? shutdownLeaving(123) : successfulShutdown()));
    const broker = new BrowserBroker({ copilotHome: root, shutdownTarget });

    const first = await broker.createSessionTarget("public");

    expect(first.publicSlot).toBe(2);
    expect(first.browserTarget.profileDir).toBe(slotDir(root, 2));
    expect(closedSlots(shutdownTarget)).toEqual([1, 2]);
    await expect(broker.getPublicProfileStats()).resolves.toEqual({ profiles: 1, inUse: 1 });

    const second = await broker.createSessionTarget("public");
    expect(second.publicSlot).toBe(3);
    expect(closedSlots(shutdownTarget)).toEqual([1, 2, 1, 3]);

    stuck = false;
    const third = await broker.createSessionTarget("public");
    expect(third.publicSlot).toBe(1);
    expect(closedSlots(shutdownTarget)).toEqual([1, 2, 1, 3, 1]);
  });

  it("fails a lease whose check for a leftover browser throws, and frees the profile", async () => {
    const root = makeTestDir("browser-broker-slot-verify-throws");
    const shutdownTarget = mockShutdown();
    shutdownTarget.mockRejectedValueOnce(new Error("process list unavailable"));
    const broker = new BrowserBroker({ copilotHome: root, shutdownTarget });

    await expect(broker.createSessionTarget("public")).rejects.toThrow("process list unavailable");

    const lease = await broker.createSessionTarget("public");
    expect(lease.publicSlot).toBe(1);
    expect(closedSlots(shutdownTarget)).toEqual([1, 1]);
  });

  it("leaves a profile with its holder when closing its browser threw, until closing it works", async () => {
    const root = makeTestDir("browser-broker-slot-failed-cleanup");
    const shutdownTarget = mockShutdown();
    const removeProfile = mockRemoveProfile();
    const broker = new BrowserBroker({ copilotHome: root, shutdownTarget, removeProfile });
    const lease = await broker.createSessionTarget("public");
    await writeFile(join(lease.browserTarget.profileDir, "Cookies"), "kept");
    shutdownTarget.mockRejectedValueOnce(new Error("shutdown failed"));

    await expect(broker.disposeSessionTarget(lease, OP)).rejects.toThrow("shutdown failed");

    // Nothing else is given the profile while its holder may try again.
    await expect(broker.getPublicProfileStats()).resolves.toEqual({ profiles: 1, inUse: 1 });
    expect((await broker.createSessionTarget("public")).publicSlot).toBe(2);

    await expect(broker.disposeSessionTarget(lease, OP)).resolves.toBeUndefined();
    await expect(broker.getPublicProfileStats()).resolves.toEqual({ profiles: 2, inUse: 1 });

    // The failed shutdown left it unknown what runs on the profile, so it is checked before its next use.
    shutdownTarget.mockClear();
    const next = await broker.createSessionTarget("public");
    expect(next.publicSlot).toBe(1);
    expect(closedSlots(shutdownTarget)).toEqual([1]);
    await expect(readFile(join(slotDir(root, 1), "Cookies"), "utf-8")).resolves.toBe("kept");

    // That check and a clean shutdown make the profile trusted again.
    await expect(broker.disposeSessionTarget(next, OP)).resolves.toBeUndefined();
    shutdownTarget.mockClear();
    expect((await broker.createSessionTarget("public")).publicSlot).toBe(1);
    expect(shutdownTarget).not.toHaveBeenCalled();
    expect(removeProfile).not.toHaveBeenCalled();
  });

  it("leaves a profile with its holder while its browser outlives the shutdown, and says which processes remained", async () => {
    const root = makeTestDir("browser-broker-slot-remaining-pids");
    const shutdownTarget = mockShutdown();
    const broker = new BrowserBroker({ copilotHome: root, shutdownTarget });
    const lease = await broker.createSessionTarget("public");
    shutdownTarget.mockResolvedValueOnce(shutdownLeaving(4242, 4243));

    await expect(broker.disposeSessionTarget(lease, OP))
      .rejects.toThrow("Public browser processes remained after cleanup: 4242, 4243");

    // The next lease passes the profile over without looking at it: it is still held.
    await expect(broker.getPublicProfileStats()).resolves.toEqual({ profiles: 1, inUse: 1 });
    expect((await broker.createSessionTarget("public")).publicSlot).toBe(2);
    expect(closedSlots(shutdownTarget)).toEqual([1, 1, 2]);

    await expect(broker.disposeSessionTarget(lease, OP)).resolves.toBeUndefined();
    expect((await broker.createSessionTarget("public")).publicSlot).toBe(1);
  });

  it("gives up the profile of a one-off operation whose browser would not close, and passes it over while that browser lives", async () => {
    const root = makeTestDir("browser-broker-slot-given-up");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    let alive = false;
    const shutdownTarget = mockShutdown((slot) => (slot === 1 && alive ? shutdownLeaving(4242) : successfulShutdown()));
    const removeProfile = mockRemoveProfile();
    const broker = new BrowserBroker({ copilotHome: root, shutdownTarget, removeProfile });
    const slotOfOperation = () => broker.withEphemeralContext("public", QUIET, async (lease) => {
      alive = true;
      return lease.publicSlot;
    });

    // Nobody holds a one-off operation's profile after it: there is no one to try the shutdown again.
    await expect(slotOfOperation()).resolves.toBe(1);
    await expect(broker.getPublicProfileStats()).resolves.toEqual({ profiles: 1, inUse: 0 });
    expect(closedSlots(shutdownTarget)).toEqual([1, 1]);

    // The check before its next use finds the browser still there.
    await expect(slotOfOperation()).resolves.toBe(2);
    expect(closedSlots(shutdownTarget)).toEqual([1, 1, 1, 2, 2]);

    alive = false;
    await expect(broker.withEphemeralContext("public", QUIET, async (lease) => lease.publicSlot))
      .resolves.toBe(1);
    expect(closedSlots(shutdownTarget)).toEqual([1, 1, 1, 2, 2, 1, 1]);
    expect(removeProfile).not.toHaveBeenCalled();
    await expect(broker.getPublicProfileStats()).resolves.toEqual({ profiles: 2, inUse: 0 });
  });

  it("passes over every profile that exists when asked for one that was never used", async () => {
    const root = makeTestDir("browser-broker-slot-unused");
    await mkdir(slotDir(root, 1), { recursive: true });
    await mkdir(slotDir(root, 3));
    const broker = new BrowserBroker({ copilotHome: root, shutdownTarget: mockShutdown() });

    const unused = await broker.createSessionTarget("public", { unused: true });
    expect(unused.publicSlot).toBe(2);
    expect(await readdir(unused.browserTarget.profileDir)).toEqual([]);
    // That profile exists now, and is held as well.
    expect((await broker.createSessionTarget("public", { unused: true })).publicSlot).toBe(4);

    // Without the wish it is the lowest free one, used or not.
    expect((await broker.createSessionTarget("public")).publicSlot).toBe(1);
    expect((await broker.createSessionTarget("public", { unused: false })).publicSlot).toBe(3);
    // The authenticated browser has the one profile.
    expect(await broker.createSessionTarget("authenticated", { unused: true }))
      .toEqual(await broker.createSessionTarget("authenticated"));
  });

  it("refuses one browser more than there are public profiles", async () => {
    const root = makeTestDir("browser-broker-slot-exhaustion");
    const broker = new BrowserBroker({ copilotHome: root, shutdownTarget: mockShutdown() });
    const leases: BrowserBrokerLease[] = [];
    for (let index = 0; index < MAX_PUBLIC_SLOTS; index++) {
      leases.push(await broker.createSessionTarget("public"));
    }

    expect(leases.map((lease) => lease.publicSlot)).toEqual(Array.from({ length: MAX_PUBLIC_SLOTS }, (_, index) => index + 1));
    await expect(broker.createSessionTarget("public")).rejects.toThrow("Every public browser profile is in use");
    await expect(broker.getPublicProfileStats()).resolves.toEqual({ profiles: MAX_PUBLIC_SLOTS, inUse: MAX_PUBLIC_SLOTS });
    expect(await exists(slotDir(root, MAX_PUBLIC_SLOTS + 1))).toBe(false);

    await broker.disposeSessionTarget(leases[6], OP);
    expect((await broker.createSessionTarget("public")).publicSlot).toBe(7);
    await expect(broker.createSessionTarget("public")).rejects.toThrow("Every public browser profile is in use");
  });
});

describe("a public profile on which the browser does not start", () => {
  /** A profile that holds this file is one no browser starts on. */
  const BROKEN_FILE = "Preferences";

  /** A broker whose browser starts on every profile without `BROKEN_FILE`, while `host.works`. */
  function createBroker(prefix: string, options: Partial<BrowserBrokerOptions> = {}) {
    const root = makeTestDir(prefix);
    const host = { works: true };
    const runCommand = vi.fn<RunCommand>(async (_command, _timeout, commandOptions) => {
      const profileDir = commandOptions.browserTarget!.profileDir;
      return host.works && !await exists(join(profileDir, BROKEN_FILE))
        ? { ok: true, output: "about:blank" }
        : { ok: false, output: `Chrome exited early (${basename(profileDir)})` };
    });
    const shutdownTarget = mockShutdown();
    const removeProfile = mockRemoveProfile();
    const { telemetryStore, spansNamed } = spanRecorder();
    const broker = new BrowserBroker({
      copilotHome: root,
      telemetryStore,
      runCommand,
      shutdownTarget,
      removeProfile,
      profileRemoveRetryDelaysMs: [],
      ...options,
    });
    /** The profiles a browser was started on, in order. */
    const triedProfiles = () => runCommand.mock.calls
      .map(([, , commandOptions]) => basename(commandOptions.browserTarget!.profileDir))
      .filter((profile, index, profiles) => profile !== profiles[index - 1]);
    const discards = () => spansNamed("browser.public.profile_reset");
    return { root, host, broker, runCommand, shutdownTarget, removeProfile, triedProfiles, discards };
  }

  /** Leaves a public profile on disk that no browser starts on. */
  async function breakProfile(root: string, slot: number): Promise<string> {
    await mkdir(slotDir(root, slot), { recursive: true });
    const file = join(slotDir(root, slot), BROKEN_FILE);
    await writeFile(file, "{ broken");
    return file;
  }

  /** A public operation that reports the profile it ran on. */
  function runPublic(broker: BrowserBroker): Promise<{ slot: number | undefined; profile: string[] }> {
    return withoutReadinessWaits(() => broker.withEphemeralContext("public", OP, async (lease) => ({
      slot: lease.publicSlot,
      profile: await readdir(lease.browserTarget.profileDir),
    })));
  }

  it("runs the operation again on a profile that was never used, and discards the first one when the browser starts there", async () => {
    const { root, broker, removeProfile, triedProfiles, discards } = createBroker("browser-broker-unstartable-retry");
    await breakProfile(root, 1);
    const operation = vi.fn(async (lease: BrowserBrokerLease) => ({
      slot: lease.publicSlot,
      profile: await readdir(lease.browserTarget.profileDir),
    }));

    const result = await withoutReadinessWaits(() => broker.withEphemeralContext("public", OP, operation));

    expect(result).toEqual({ slot: 2, profile: [] });
    // The first run never reached the operation: its browser did not start.
    expect(operation).toHaveBeenCalledTimes(1);
    expect(triedProfiles()).toEqual(["slot-1", "slot-2"]);
    expect(removeProfile.mock.calls).toEqual([[slotDir(root, 1)]]);
    expect(await readdir(publicRoot(root))).toEqual(["slot-2"]);
    expect(discards()).toEqual([expect.objectContaining({ publicSlot: 1, removed: true })]);
    const health = broker.getSnapshot().public;
    expect(health).toMatchObject({ status: "ready", activeOperations: 0, queuedOperations: 0 });
    expect(health).not.toHaveProperty("lastError");
    await expect(broker.getPublicProfileStats()).resolves.toEqual({ profiles: 1, inUse: 0 });

    // The discarded profile's slot is the lowest free one again, and a browser starts on it from nothing.
    await expect(runPublic(broker)).resolves.toEqual({ slot: 1, profile: [] });
    expect(removeProfile).toHaveBeenCalledTimes(1);
  });

  it("reports the operation's own failure when the browser started on the unused profile, and discards the first one", async () => {
    const { root, broker, removeProfile, triedProfiles } = createBroker("browser-broker-unstartable-operation-fails");
    await breakProfile(root, 1);

    const failure = await withoutReadinessWaits(() => broker.withEphemeralContext("public", OP, async () => {
      throw new Error("the page would not load");
    })).catch((error: unknown) => error);

    // The start on the second profile is the proof that the first one stood in the way.
    expect(failure).toMatchObject({ message: "the page would not load" });
    expect(triedProfiles()).toEqual(["slot-1", "slot-2"]);
    expect(removeProfile.mock.calls).toEqual([[slotDir(root, 1)]]);
    expect(await readdir(publicRoot(root))).toEqual(["slot-2"]);
  });

  it("does not take a profile for free of a browser when neither its close nor the process list could say so", async () => {
    const { broker, shutdownTarget } = createBroker("browser-broker-unconfirmed-close");
    const unconfirmed = { ...successfulShutdown(), ok: false, closeOk: false, processListFailed: true };
    // The leftover check before slot 1's first use learns nothing, so the lease moves on.
    shutdownTarget.mockResolvedValueOnce(unconfirmed);

    const lease = await broker.createSessionTarget("public");
    expect(lease.publicSlot).toBe(2);

    // The same when the session's own browser is closed: the profile stays with the session.
    shutdownTarget.mockResolvedValueOnce(unconfirmed);
    await expect(broker.disposeSessionTarget(lease, OP)).rejects.toThrow(/did not confirm that it closed/);
    await expect(broker.getPublicProfileStats()).resolves.toMatchObject({ inUse: 1 });

    await expect(broker.disposeSessionTarget(lease, OP)).resolves.toBeUndefined();
    await expect(broker.getPublicProfileStats()).resolves.toMatchObject({ inUse: 0 });
  });

  it("passes over every profile that exists or is held for the second run", async () => {
    const { root, broker, triedProfiles, removeProfile } = createBroker("browser-broker-unstartable-unused");
    // The first profile belongs to a browser session, the third is left from an earlier server.
    const session = await broker.createSessionTarget("public");
    await breakProfile(root, 2);
    await mkdir(slotDir(root, 3));
    await writeFile(join(slotDir(root, 3), "Cookies"), "from an earlier server");

    await expect(runPublic(broker)).resolves.toEqual({ slot: 4, profile: [] });

    expect(session.publicSlot).toBe(1);
    expect(triedProfiles()).toEqual(["slot-2", "slot-4"]);
    expect(removeProfile.mock.calls).toEqual([[slotDir(root, 2)]]);
    expect((await readdir(publicRoot(root))).sort()).toEqual(["slot-1", "slot-3", "slot-4"]);
    await expect(readFile(join(slotDir(root, 3), "Cookies"), "utf-8")).resolves.toBe("from an earlier server");
    await expect(broker.getPublicProfileStats()).resolves.toEqual({ profiles: 3, inUse: 1 });
  });

  it("tries no second profile when the first was made for this very operation, and removes its folder again", async () => {
    const { root, host, broker, removeProfile, triedProfiles } = createBroker("browser-broker-unstartable-first-ever");
    // No public browser ever ran here, so nothing in the profile can be what stands in the way.
    host.works = false;
    const operation = vi.fn(async () => "never reached");

    const failure = await withoutReadinessWaits(() => broker.withEphemeralContext("public", OP, operation))
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(BrowserUnavailableError);
    expect(failure).toMatchObject({ message: "Browser public context is unavailable: Chrome exited early (slot-1)" });
    expect(operation).not.toHaveBeenCalled();
    expect(triedProfiles()).toEqual(["slot-1"]);
    // Otherwise every failed call on such a host would leave a folder behind.
    expect(removeProfile.mock.calls).toEqual([[slotDir(root, 1)]]);
    expect(await readdir(publicRoot(root))).toEqual([]);
    await expect(broker.getPublicProfileStats()).resolves.toEqual({ profiles: 0, inUse: 0 });

    // Once the host lets browsers start, the same slot serves the next call.
    host.works = true;
    await expect(runPublic(broker)).resolves.toEqual({ slot: 1, profile: [] });
  });

  it("throws the first failure, keeps the first profile and removes the second when the browser starts on neither", async () => {
    const { root, host, broker, removeProfile, triedProfiles } = createBroker("browser-broker-unstartable-host");
    await mkdir(slotDir(root, 1), { recursive: true });
    await writeFile(join(slotDir(root, 1), "Cookies"), "from an earlier server");
    host.works = false;
    const operation = vi.fn(async () => "never reached");

    const failure = await withoutReadinessWaits(() => broker.withEphemeralContext("public", OP, operation))
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(BrowserUnavailableError);
    expect(failure).toMatchObject({ message: "Browser public context is unavailable: Chrome exited early (slot-1)" });
    // Two runs and no third.
    expect(triedProfiles()).toEqual(["slot-1", "slot-2"]);
    expect(operation).not.toHaveBeenCalled();
    // The host is at fault, not the profile: the first one stays, and the one made to find that out goes.
    expect(removeProfile.mock.calls).toEqual([[slotDir(root, 2)]]);
    expect(await readdir(publicRoot(root))).toEqual(["slot-1"]);
    await expect(readFile(join(slotDir(root, 1), "Cookies"), "utf-8")).resolves.toBe("from an earlier server");
    expect(broker.getSnapshot().public).toMatchObject({
      status: "unavailable",
      activeOperations: 0,
      queuedOperations: 0,
      lastError: expect.stringContaining("Browser public context is unavailable: Chrome exited early"),
    });
    await expect(broker.getPublicProfileStats()).resolves.toEqual({ profiles: 1, inUse: 0 });
  });

  it.each([
    ["with no profile from earlier", false, []],
    ["beside a profile from earlier", true, ["slot-1"]],
  ])("says that the browser does not start, and leaves no folder behind, however often it fails %s", async (
    _name,
    earlierProfile,
    folders,
  ) => {
    const { root, host, broker } = createBroker("browser-broker-unstartable-host-again");
    if (earlierProfile) await mkdir(slotDir(root, 1), { recursive: true });
    host.works = false;
    const failures: string[] = [];

    await withoutReadinessWaits(async () => {
      for (let attempt = 0; attempt < MAX_PUBLIC_SLOTS; attempt++) {
        failures.push(await broker.withEphemeralContext("public", OP, async () => "never reached")
          .then(() => "the operation ran", (error: unknown) => (error as Error).message));
      }
    });

    // On a host that refuses the browser, every operation fails for that reason, and none for
    // the profiles its predecessors tried.
    expect(failures.filter((message) => !message.startsWith("Browser public context is unavailable: Chrome exited early")))
      .toEqual([]);
    expect(await exists(publicRoot(root)) ? await readdir(publicRoot(root)) : []).toEqual(folders);
    await expect(broker.getPublicProfileStats()).resolves.toEqual({ profiles: folders.length, inUse: 0 });
  });

  it("does not run an operation again that failed after its browser had started", async () => {
    const { root, broker, removeProfile, triedProfiles } = createBroker("browser-broker-unstartable-operation-failed");
    const operation = vi.fn<(lease: BrowserBrokerLease) => Promise<void>>()
      .mockImplementationOnce(async (lease) => {
        await writeFile(join(lease.browserTarget.profileDir, "Cookies"), "kept");
        throw new Error("the page did not load");
      })
      // Only the broker's own finding counts, not a failure that reads like it.
      .mockRejectedValueOnce(new Error("Browser public context is unavailable: Chrome exited early"));

    await expect(broker.withEphemeralContext("public", OP, operation)).rejects.toThrow("the page did not load");
    await expect(broker.withEphemeralContext("public", OP, operation))
      .rejects.toThrow("Browser public context is unavailable: Chrome exited early");

    expect(operation).toHaveBeenCalledTimes(2);
    expect(triedProfiles()).toEqual(["slot-1"]);
    expect(removeProfile).not.toHaveBeenCalled();
    await expect(readFile(join(slotDir(root, 1), "Cookies"), "utf-8")).resolves.toBe("kept");
    expect(broker.getSnapshot().public.status).toBe("degraded");
  });

  it("runs an operation once that skips the readiness check, whatever it fails with", async () => {
    const { root, host, broker, removeProfile, runCommand } = createBroker("browser-broker-unstartable-skip-readiness");
    const brokenFile = await breakProfile(root, 1);
    host.works = false;
    const operation = vi.fn(async () => {
      throw new Error("Chrome exited early");
    });

    await expect(broker.withEphemeralContext("public", QUIET, operation))
      .rejects.toThrow("Chrome exited early");

    expect(runCommand).not.toHaveBeenCalled();
    expect(operation).toHaveBeenCalledTimes(1);
    expect(removeProfile).not.toHaveBeenCalled();
    await expect(readFile(brokenFile, "utf-8")).resolves.toBe("{ broken");
  });

  it("keeps its turn across both runs, so that nothing waiting comes between them", async () => {
    const { root, broker } = createBroker("browser-broker-unstartable-capacity", { publicConcurrency: 1 });
    await breakProfile(root, 1);
    const order: string[] = [];
    let waitingDuringSecondRun: number | undefined;

    await withoutReadinessWaits(() => Promise.all([
      broker.withEphemeralContext("public", OP, async (lease) => {
        waitingDuringSecondRun = broker.getSnapshot().public.queuedOperations;
        order.push(`first on ${lease.publicSlot}`);
      }),
      broker.withEphemeralContext("public", OP, async (lease) => {
        order.push(`second on ${lease.publicSlot}`);
      }),
    ]));

    // The only place was taken once for both runs: the second run did not wait for it behind
    // the other operation, which got it when the first profile was gone.
    expect(order).toEqual(["first on 2", "second on 1"]);
    expect(waitingDuringSecondRun).toBe(1);
    expect(broker.getSnapshot().public).toMatchObject({ status: "ready", activeOperations: 0, queuedOperations: 0 });
    // And it was given back once: the next operation does not wait.
    await expect(runPublic(broker)).resolves.toEqual({ slot: 1, profile: [] });
  });

  it("leaves the first profile alone when something else took it in the meantime", async () => {
    const { root, broker, removeProfile, discards } = createBroker("browser-broker-unstartable-taken");
    const brokenFile = await breakProfile(root, 1);
    let session: BrowserBrokerLease | undefined;

    const slot = await withoutReadinessWaits(() => broker.withEphemeralContext("public", OP, async (lease) => {
      // A browser session starts while the operation runs on the fresh profile.
      session = await broker.createSessionTarget("public");
      return lease.publicSlot;
    }));

    expect(slot).toBe(2);
    expect(session?.publicSlot).toBe(1);
    expect(removeProfile).not.toHaveBeenCalled();
    expect(discards()).toEqual([expect.objectContaining({ publicSlot: 1, removed: false })]);
    await expect(readFile(brokenFile, "utf-8")).resolves.toBe("{ broken");
    await expect(broker.getPublicProfileStats()).resolves.toEqual({ profiles: 2, inUse: 1 });
  });

  it("tries again to remove the first profile while its files are still open", async () => {
    const stillOpen = Object.assign(new Error("EBUSY: resource busy or locked, unlink 'lockfile'"), { code: "EBUSY" });
    // The production waits between the attempts; they do not take their time here.
    const { root, broker, removeProfile } = createBroker("browser-broker-unstartable-remove-retry", {
      profileRemoveRetryDelaysMs: undefined,
    });
    removeProfile.mockRejectedValueOnce(stillOpen).mockRejectedValueOnce(stillOpen);
    await breakProfile(root, 1);

    await expect(runPublic(broker)).resolves.toEqual({ slot: 2, profile: [] });

    expect(removeProfile.mock.calls).toEqual([[slotDir(root, 1)], [slotDir(root, 1)], [slotDir(root, 1)]]);
    expect(await exists(slotDir(root, 1))).toBe(false);
  });

  it("returns what the second run returned when the first profile cannot be removed", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { root, broker, removeProfile } = createBroker("browser-broker-unstartable-remove-fails", {
      profileRemoveRetryDelaysMs: [0, 0],
    });
    removeProfile.mockRejectedValue(Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" }));
    const brokenFile = await breakProfile(root, 1);

    await expect(runPublic(broker)).resolves.toEqual({ slot: 2, profile: [] });

    expect(removeProfile.mock.calls).toEqual([[slotDir(root, 1)], [slotDir(root, 1)], [slotDir(root, 1)]]);
    await expect(readFile(brokenFile, "utf-8")).resolves.toBe("{ broken");
    expect(broker.getSnapshot().public.status).toBe("ready");
    // The profile is not left held by the removal that failed.
    await expect(broker.getPublicProfileStats()).resolves.toEqual({ profiles: 2, inUse: 0 });
  });

  describe("when the first browser could not be closed cleanly", () => {
    /** A broker that has checked and used its first profile, which is broken now. */
    async function createBrokerWithUsedProfile(prefix: string) {
      const created = createBroker(prefix);
      await created.broker.disposeSessionTarget(await created.broker.createSessionTarget("public"), OP);
      const brokenFile = await breakProfile(created.root, 1);
      created.shutdownTarget.mockClear();
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      return { ...created, brokenFile };
    }

    it("keeps the first profile while a browser is still running on it", async () => {
      const { broker, shutdownTarget, removeProfile, brokenFile } =
        await createBrokerWithUsedProfile("browser-broker-unstartable-leftover");
      shutdownTarget.mockImplementation(async (target) => (slotOf(target) === 1 ? shutdownLeaving(900) : successfulShutdown()));

      await expect(runPublic(broker)).resolves.toEqual({ slot: 2, profile: [] });

      // Closed after the first run, checked and closed around the second, then looked for once more.
      expect(closedSlots(shutdownTarget)).toEqual([1, 2, 2, 1]);
      expect(removeProfile).not.toHaveBeenCalled();
      await expect(readFile(brokenFile, "utf-8")).resolves.toBe("{ broken");
      await expect(broker.getPublicProfileStats()).resolves.toEqual({ profiles: 2, inUse: 0 });
    });

    it("discards the first profile once that browser is gone", async () => {
      const { root, broker, shutdownTarget, removeProfile } =
        await createBrokerWithUsedProfile("browser-broker-unstartable-leftover-gone");
      shutdownTarget.mockResolvedValueOnce(shutdownLeaving(900));

      await expect(runPublic(broker)).resolves.toEqual({ slot: 2, profile: [] });

      expect(removeProfile.mock.calls).toEqual([[slotDir(root, 1)]]);
      expect(await exists(slotDir(root, 1))).toBe(false);
    });

    it("keeps the first profile, and the operation's value, when it cannot be checked for a browser", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const { broker, shutdownTarget, removeProfile, brokenFile } =
        await createBrokerWithUsedProfile("browser-broker-unstartable-leftover-unknown");
      shutdownTarget
        .mockResolvedValueOnce(shutdownLeaving(900))
        .mockResolvedValueOnce(successfulShutdown())
        .mockResolvedValueOnce(successfulShutdown())
        .mockRejectedValueOnce(new Error("process list unavailable"));

      await expect(runPublic(broker)).resolves.toEqual({ slot: 2, profile: [] });

      expect(removeProfile).not.toHaveBeenCalled();
      await expect(readFile(brokenFile, "utf-8")).resolves.toBe("{ broken");
      await expect(broker.getPublicProfileStats()).resolves.toEqual({ profiles: 2, inUse: 0 });
    });
  });

  it("returns the value and discards the first profile even when the second browser cannot be closed", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { root, broker, shutdownTarget, removeProfile } = createBroker("browser-broker-unstartable-second-cleanup");
    await breakProfile(root, 1);
    let closesOfSecond = 0;
    shutdownTarget.mockImplementation(async (target) => {
      // The check before the second profile's first use passes; closing its browser throws.
      if (slotOf(target) === 2 && ++closesOfSecond === 2) throw new Error("shutdown failed");
      return successfulShutdown();
    });

    await expect(runPublic(broker)).resolves.toEqual({ slot: 2, profile: [] });

    expect(removeProfile.mock.calls).toEqual([[slotDir(root, 1)]]);
    expect(await readdir(publicRoot(root))).toEqual(["slot-2"]);
    await expect(broker.getPublicProfileStats()).resolves.toEqual({ profiles: 1, inUse: 0 });
  });

  it("tries no second profile for a browser session or for the authenticated browser", async () => {
    const { root, host, broker, removeProfile, shutdownTarget, triedProfiles } =
      createBroker("browser-broker-unstartable-session");
    const lease = await broker.createSessionTarget("public");
    await writeFile(join(lease.browserTarget.profileDir, "Cookies"), "kept");
    host.works = false;
    const operation = vi.fn(async () => "never reached");

    const failure = await withoutReadinessWaits(() => broker.withTarget(lease, OP, operation))
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(BrowserUnavailableError);
    expect(failure).toMatchObject({ message: "Browser public context is unavailable: Chrome exited early (slot-1)" });
    // Closing the session's browser keeps its profile, as it does for any other.
    await expect(broker.disposeSessionTarget(lease, OP)).resolves.toBeUndefined();
    await expect(readFile(join(slotDir(root, 1), "Cookies"), "utf-8")).resolves.toBe("kept");

    // The authenticated profile is never the broker's to replace, and its browser stays open.
    shutdownTarget.mockClear();
    await expect(withoutReadinessWaits(() => broker.withEphemeralContext("authenticated", OP, operation)))
      .rejects.toThrow("Browser authenticated context is unavailable: Chrome exited early (browser-profile)");
    await expect(broker.disposeSessionTarget(await broker.createSessionTarget("authenticated"), OP))
      .resolves.toBeUndefined();

    expect(triedProfiles()).toEqual(["slot-1", "browser-profile"]);
    expect(shutdownTarget).not.toHaveBeenCalled();
    expect(operation).not.toHaveBeenCalled();
    expect(removeProfile).not.toHaveBeenCalled();
  });
});

describe("a browser the user is acting in", () => {
  function heldMessage(purpose: string): string {
    return `The user has this browser right now (${purpose}). Try again after they hand it back.`;
  }

  function createBroker(prefix: string, options: Partial<BrowserBrokerOptions> = {}) {
    const root = makeTestDir(prefix);
    const runCommand = mockBrowser();
    const shutdownTarget = mockShutdown();
    const broker = new BrowserBroker({ copilotHome: root, runCommand, shutdownTarget, ...options });
    return { root, broker, runCommand, shutdownTarget };
  }

  /** An operation that stays in its browser until `finish` lets it go. */
  function occupy(broker: BrowserBroker, lease: BrowserBrokerLease) {
    let finish!: () => void;
    let markEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    const done = broker.withTarget(lease, QUIET, async () => {
      markEntered();
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
    });
    return { entered, done, finish: () => finish() };
  }

  it("refuses an operation on it and says what the user was asked to do", async () => {
    const { broker, runCommand } = createBroker("browser-broker-held");
    const lease = await broker.createSessionTarget("public");
    const operation = vi.fn(async () => "ran");

    broker.holdTarget(lease, "sign in to the store");

    await expect(broker.withTarget(lease, OP, operation)).rejects.toThrow(heldMessage("sign in to the store"));
    await expect(broker.withTarget(lease, QUIET, operation)).rejects.toThrow(heldMessage("sign in to the store"));
    expect(operation).not.toHaveBeenCalled();
    // The browser is not even asked whether it is ready, and a refusal is no failure of the browser.
    expect(runCommand).not.toHaveBeenCalled();
    const health = broker.getSnapshot().public;
    expect(health).toMatchObject({ status: "stopped", activeOperations: 0, queuedOperations: 0 });
    expect(health).not.toHaveProperty("lastError");
    expect(health).not.toHaveProperty("lastFailureAt");
  });

  it("runs what is part of the user's own use of it", async () => {
    const { broker, runCommand } = createBroker("browser-broker-held-during");
    const lease = await broker.createSessionTarget("public");
    broker.holdTarget(lease, "sign in to the store");

    await expect(broker.withTarget(lease, { ...OP, duringHold: true }, async (held) => held.publicSlot))
      .resolves.toBe(1);

    expect(runCommand.mock.calls.map(([command]) => command.join(" "))).toEqual(["get url", "get title"]);
    expect(broker.getSnapshot().public.status).toBe("ready");
  });

  it("leaves every other browser alone", async () => {
    const { broker } = createBroker("browser-broker-held-others");
    const held = await broker.createSessionTarget("public");
    const other = await broker.createSessionTarget("public");
    broker.holdTarget(held, "sign in to the store");

    await expect(broker.withTarget(other, OP, async (lease) => lease.publicSlot)).resolves.toBe(2);
    await expect(broker.withEphemeralContext("public", OP, async (lease) => lease.publicSlot)).resolves.toBe(3);
    await expect(broker.withEphemeralContext("authenticated", OP, async (lease) => lease.context))
      .resolves.toBe("authenticated");
    await expect(broker.withTarget(held, OP, async () => "ran")).rejects.toThrow(heldMessage("sign in to the store"));
  });

  it("takes operations again once the user has handed it back, and is handed back only by the handover that took it", async () => {
    const { broker } = createBroker("browser-broker-held-released");
    const lease = await broker.createSessionTarget("public");
    const run = () => broker.withTarget(lease, QUIET, async () => "ran");

    const handBackFirst = broker.holdTarget(lease, "sign in to the store");
    await expect(run()).rejects.toThrow(heldMessage("sign in to the store"));
    handBackFirst();
    await expect(run()).resolves.toBe("ran");

    // The first handover is over; handing it back once more must not end a later one, even one
    // that gives the same reason.
    const handBackSecond = broker.holdTarget(lease, "sign in to the store");
    handBackFirst();
    await expect(run()).rejects.toThrow(heldMessage("sign in to the store"));
    handBackSecond();
    await expect(run()).resolves.toBe("ran");
  });

  it("refuses to hand over a browser the user already has, and leaves the first handover as it is", async () => {
    const { broker } = createBroker("browser-broker-held-twice");
    const lease = await broker.createSessionTarget("public");
    const run = () => broker.withTarget(lease, QUIET, async () => "ran");

    const handBackFirst = broker.holdTarget(lease, "sign in to the store");
    expect(() => broker.holdTarget(lease, "solve the puzzle")).toThrow(heldMessage("sign in to the store"));
    await expect(run()).rejects.toThrow(heldMessage("sign in to the store"));

    handBackFirst();
    await expect(run()).resolves.toBe("ran");
  });

  it("holds the authenticated browser too, whichever way it is reached", async () => {
    const { broker, shutdownTarget } = createBroker("browser-broker-held-authenticated");
    const lease = await broker.createSessionTarget("authenticated");
    const operation = vi.fn(async () => "ran");

    const handBack = broker.holdTarget(lease, "approve the sign-in");

    await expect(broker.withEphemeralContext("authenticated", QUIET, operation))
      .rejects.toThrow(heldMessage("approve the sign-in"));
    // The window the diagnostics page opens is the same browser.
    await expect(broker.withTarget({
      context: "authenticated",
      browserTarget: { ...lease.browserTarget, headed: true },
    }, QUIET, operation)).rejects.toThrow(heldMessage("approve the sign-in"));
    expect(operation).not.toHaveBeenCalled();
    expect(broker.getSnapshot().authenticated).toMatchObject({ status: "stopped", activeOperations: 0, queuedOperations: 0 });
    await expect(broker.withEphemeralContext("authenticated", { ...QUIET, duringHold: true }, operation))
      .resolves.toBe("ran");
    await expect(broker.withEphemeralContext("public", QUIET, operation)).resolves.toBe("ran");

    // Disposing an authenticated target closes nothing, so the user still has the browser.
    await broker.disposeSessionTarget(lease, OP);
    expect(shutdownTarget.mock.calls.map(([target]) => target.sessionName))
      .not.toContain(lease.browserTarget.sessionName);
    await expect(broker.withEphemeralContext("authenticated", QUIET, operation))
      .rejects.toThrow(heldMessage("approve the sign-in"));

    handBack();
    await expect(broker.withEphemeralContext("authenticated", QUIET, operation)).resolves.toBe("ran");
  });

  it("is nobody's once it has been closed", async () => {
    const { broker } = createBroker("browser-broker-held-disposed");
    const lease = await broker.createSessionTarget("public");
    const handBack = broker.holdTarget(lease, "sign in to the store");

    await broker.disposeSessionTarget(lease, OP);

    // The next browser on the profile has the same session name and is free.
    const next = await broker.createSessionTarget("public");
    expect(next.browserTarget.sessionName).toBe(lease.browserTarget.sessionName);
    await expect(broker.withTarget(next, QUIET, async () => "ran")).resolves.toBe("ran");

    // Handing back the browser that is gone does not hand back the one a user got since.
    broker.holdTarget(next, "solve the puzzle");
    handBack();
    await expect(broker.withTarget(next, QUIET, async () => "ran")).rejects.toThrow(heldMessage("solve the puzzle"));
  });

  it("refuses an operation that was waiting for a free place when the user took the browser", async () => {
    const { broker } = createBroker("browser-broker-held-queued-capacity", { publicConcurrency: 1 });
    const busy = await broker.createSessionTarget("public");
    const lease = await broker.createSessionTarget("public");
    const operation = vi.fn(async () => "ran");
    const running = occupy(broker, busy);
    await running.entered;

    const waiting = broker.withTarget(lease, QUIET, operation);
    const outcome = waiting.then(() => "ran", (error: unknown) => (error as Error).message);
    expect(broker.getSnapshot().public.queuedOperations).toBe(1);
    const handBack = broker.holdTarget(lease, "sign in to the store");
    running.finish();
    await running.done;

    await expect(outcome).resolves.toBe(heldMessage("sign in to the store"));
    expect(operation).not.toHaveBeenCalled();
    // The place it had waited for went back: the next operation gets it at once.
    handBack();
    await expect(broker.withTarget(lease, QUIET, operation)).resolves.toBe("ran");
    expect(broker.getSnapshot().public).toMatchObject({ activeOperations: 0, queuedOperations: 0 });
  });

  it("refuses an operation that was waiting its turn on the browser when the user took it", async () => {
    const { broker } = createBroker("browser-broker-held-queued-target");
    const lease = await broker.createSessionTarget("public");
    const operation = vi.fn(async () => "ran");
    const running = occupy(broker, lease);
    await running.entered;

    // It is behind the running operation on the same browser, as a second tool call of a chat is.
    const outcome = broker.withTarget(lease, QUIET, operation)
      .then(() => "ran", (error: unknown) => (error as Error).message);
    // Nothing but promise callbacks stands between it and the browser's queue; one turn of the
    // event loop runs them all.
    await new Promise<void>((resolve) => setImmediate(resolve));
    const handBack = broker.holdTarget(lease, "sign in to the store");
    running.finish();
    await running.done;

    // Its turn comes while the user has the browser: running now would navigate away under them.
    await expect(outcome).resolves.toBe(heldMessage("sign in to the store"));
    expect(operation).not.toHaveBeenCalled();
    handBack();
    await expect(broker.withTarget(lease, QUIET, operation)).resolves.toBe("ran");
  });
});

describe("public profile statistics and reset", () => {
  it("counts no profiles before the first public browser", async () => {
    const root = makeTestDir("browser-broker-stats-empty");
    const shutdownTarget = mockShutdown();
    const broker = new BrowserBroker({ copilotHome: root, shutdownTarget });

    await expect(broker.getPublicProfileStats()).resolves.toEqual({ profiles: 0, inUse: 0 });
    await expect(broker.resetPublicProfiles()).resolves.toEqual({ cleared: 0, inUse: 0 });

    expect(await exists(publicRoot(root))).toBe(false);
    expect(shutdownTarget).not.toHaveBeenCalled();
  });

  it("counts the profile folders and the ones a browser is using, and nothing else", async () => {
    const root = makeTestDir("browser-broker-stats");
    const broker = new BrowserBroker({ copilotHome: root, shutdownTarget: mockShutdown() });
    const first = await broker.createSessionTarget("public");
    const second = await broker.createSessionTarget("public");
    const third = await broker.createSessionTarget("public");
    await broker.disposeSessionTarget(second, OP);
    for (const name of ["profile-1a2b3c4d", "other", "slot-x", "slots"]) {
      await mkdir(join(publicRoot(root), name));
    }
    await writeFile(join(publicRoot(root), "slot-9"), "a file, not a profile");

    await expect(broker.getPublicProfileStats()).resolves.toEqual({ profiles: 3, inUse: 2 });

    await broker.disposeSessionTarget(first, OP);
    await broker.disposeSessionTarget(third, OP);
    await expect(broker.getPublicProfileStats()).resolves.toEqual({ profiles: 3, inUse: 0 });
  });

  it("takes only folders named slot-<n>, n from 1 and without a leading zero, for profiles", async () => {
    const root = makeTestDir("browser-broker-slot-names");
    const lookalikes = ["slot-", "slot-0", "slot-01", "slot-1.0", "slot-1e1", "slot--3", "slot- 7", "slot-2x"];
    for (const name of lookalikes) {
      await mkdir(join(publicRoot(root), name), { recursive: true });
      await writeFile(join(publicRoot(root), name, "Preferences"), "{}");
    }
    await mkdir(slotDir(root, 12));
    const shutdownTarget = mockShutdown();
    const removeProfile = mockRemoveProfile();
    const broker = new BrowserBroker({ copilotHome: root, shutdownTarget, removeProfile });

    await expect(broker.getPublicProfileStats()).resolves.toEqual({ profiles: 1, inUse: 0 });
    // A profile that has never been used is the lowest one without a folder: none of these stands for 1.
    const fresh = await broker.createSessionTarget("public", { unused: true });
    expect(fresh.publicSlot).toBe(1);
    await broker.disposeSessionTarget(fresh, OP);

    await expect(broker.resetPublicProfiles()).resolves.toEqual({ cleared: 2, inUse: 0 });

    expect(removeProfile.mock.calls.map(([profileDir]) => profileDir).sort()).toEqual([slotDir(root, 1), slotDir(root, 12)].sort());
    for (const name of lookalikes) {
      await expect(readFile(join(publicRoot(root), name, "Preferences"), "utf-8")).resolves.toBe("{}");
    }
  });

  it("clears every profile no browser is using and leaves the others alone", async () => {
    const root = makeTestDir("browser-broker-reset");
    const shutdownTarget = mockShutdown();
    // No removeProfile: the directories are removed the way production removes them.
    const broker = new BrowserBroker({ copilotHome: root, shutdownTarget });
    const authenticatedProfile = broker.getAuthenticatedTarget().profileDir;
    await mkdir(authenticatedProfile, { recursive: true });
    await writeFile(join(authenticatedProfile, "Cookies"), "signed in");
    const leases = [
      await broker.createSessionTarget("public"),
      await broker.createSessionTarget("public"),
      await broker.createSessionTarget("public"),
      await broker.createSessionTarget("public"),
    ];
    for (const lease of leases) {
      await mkdir(join(lease.browserTarget.profileDir, "Default"));
      await writeFile(join(lease.browserTarget.profileDir, "Default", "Cookies"), `slot ${lease.publicSlot}`);
    }
    await broker.disposeSessionTarget(leases[1], OP);
    await broker.disposeSessionTarget(leases[3], OP);
    shutdownTarget.mockClear();

    await expect(broker.resetPublicProfiles()).resolves.toEqual({ cleared: 2, inUse: 2 });

    expect((await readdir(publicRoot(root))).sort()).toEqual(["slot-1", "slot-3"]);
    await expect(readFile(join(slotDir(root, 1), "Default", "Cookies"), "utf-8")).resolves.toBe("slot 1");
    await expect(readFile(join(slotDir(root, 3), "Default", "Cookies"), "utf-8")).resolves.toBe("slot 3");
    await expect(readFile(join(authenticatedProfile, "Cookies"), "utf-8")).resolves.toBe("signed in");
    // Closed cleanly before, so no browser had to be looked for again.
    expect(shutdownTarget).not.toHaveBeenCalled();
    await expect(broker.getPublicProfileStats()).resolves.toEqual({ profiles: 2, inUse: 2 });

    // The next browser on a cleared profile starts from nothing.
    const next = await broker.createSessionTarget("public");
    expect(next.publicSlot).toBe(2);
    expect(await readdir(next.browserTarget.profileDir)).toEqual([]);
  });

  it("checks a profile for a leftover browser before clearing it and counts one it cannot stop as in use", async () => {
    const root = makeTestDir("browser-broker-reset-leftover");
    await mkdir(join(root, "browser-profile"), { recursive: true });
    await writeFile(join(root, "browser-profile", "Cookies"), "signed in");
    for (const slot of [1, 2, 3]) {
      await mkdir(slotDir(root, slot), { recursive: true });
      await writeFile(join(slotDir(root, slot), "Cookies"), `slot ${slot}`);
    }
    const events: string[] = [];
    const shutdownTarget = vi.fn<ShutdownTarget>(async (target) => {
      events.push(`close ${target.sessionName.replace(/^copilot-bridge-public-[a-f0-9]{8}-/, "public slot ")}`);
      return slotOf(target) === 2 ? shutdownLeaving(555) : successfulShutdown();
    });
    const removeProfile = vi.fn<RemoveProfile>(async (profileDir) => {
      events.push(`remove ${profileDir.slice(root.length + 1).replaceAll("\\", "/")}`);
      await rm(profileDir, { recursive: true, force: true });
    });
    // A server that has just started: it knows nothing about the profiles on disk.
    const broker = new BrowserBroker({ copilotHome: root, shutdownTarget, removeProfile });

    await expect(broker.resetPublicProfiles()).resolves.toEqual({ cleared: 2, inUse: 1 });

    // Only public browsers are closed and only public profiles are removed.
    expect(events).toEqual([
      "close public slot 1",
      "remove browser-public/slot-1",
      "close public slot 2",
      "close public slot 3",
      "remove browser-public/slot-3",
    ]);
    expect(await readdir(publicRoot(root))).toEqual(["slot-2"]);
    await expect(readFile(join(slotDir(root, 2), "Cookies"), "utf-8")).resolves.toBe("slot 2");
    await expect(readFile(join(root, "browser-profile", "Cookies"), "utf-8")).resolves.toBe("signed in");
    // The profile it could not clear is not held: a lease still passes it over while its browser lives.
    await expect(broker.getPublicProfileStats()).resolves.toEqual({ profiles: 1, inUse: 0 });
    expect((await broker.createSessionTarget("public")).publicSlot).toBe(1);
  });

  it("tries again to remove a public profile whose files are still open", async () => {
    const root = makeTestDir("browser-broker-remove-retry");
    await mkdir(slotDir(root, 1), { recursive: true });
    const stillOpen = Object.assign(new Error("EBUSY: resource busy or locked, unlink 'lockfile'"), { code: "EBUSY" });
    const removeProfile = vi.fn<RemoveProfile>()
      .mockRejectedValueOnce(stillOpen)
      .mockRejectedValueOnce(stillOpen)
      .mockResolvedValue(undefined);
    const broker = new BrowserBroker({
      copilotHome: root,
      shutdownTarget: mockShutdown(),
      removeProfile,
      profileRemoveRetryDelaysMs: [0, 0, 0],
    });

    await expect(broker.resetPublicProfiles()).resolves.toEqual({ cleared: 1, inUse: 0 });

    expect(removeProfile).toHaveBeenCalledTimes(3);
    expect(removeProfile).toHaveBeenCalledWith(slotDir(root, 1));
  });

  it("counts a public profile it could not remove after the last attempt as in use, and clears the others", async () => {
    const root = makeTestDir("browser-broker-remove-gives-up");
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await mkdir(slotDir(root, 1), { recursive: true });
    await mkdir(slotDir(root, 2));
    const removeProfile = vi.fn<RemoveProfile>(async (profileDir) => {
      if (profileDir === slotDir(root, 1)) {
        throw Object.assign(new Error("EBUSY: resource busy or locked, unlink 'lockfile'"), { code: "EBUSY" });
      }
      await rm(profileDir, { recursive: true, force: true });
    });
    const broker = new BrowserBroker({
      copilotHome: root,
      shutdownTarget: mockShutdown(),
      removeProfile,
      profileRemoveRetryDelaysMs: [0, 0],
    });

    await expect(broker.resetPublicProfiles()).resolves.toEqual({ cleared: 1, inUse: 1 });

    expect(removeProfile.mock.calls).toEqual([
      [slotDir(root, 1)],
      [slotDir(root, 1)],
      [slotDir(root, 1)],
      [slotDir(root, 2)],
    ]);
    expect(await readdir(publicRoot(root))).toEqual(["slot-1"]);
    // The profile is not left held by the reset that could not remove it.
    await expect(broker.getPublicProfileStats()).resolves.toEqual({ profiles: 1, inUse: 0 });
    expect((await broker.createSessionTarget("public")).publicSlot).toBe(1);
  });

  it("counts a public profile it could not check for a leftover browser as in use, and clears the others", async () => {
    const root = makeTestDir("browser-broker-reset-check-throws");
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await mkdir(slotDir(root, 1), { recursive: true });
    await mkdir(slotDir(root, 2));
    const shutdownTarget = mockShutdown();
    shutdownTarget.mockRejectedValueOnce(new Error("process list unavailable"));
    const removeProfile = mockRemoveProfile();
    const broker = new BrowserBroker({ copilotHome: root, shutdownTarget, removeProfile });

    await expect(broker.resetPublicProfiles()).resolves.toEqual({ cleared: 1, inUse: 1 });

    expect(closedSlots(shutdownTarget)).toEqual([1, 2]);
    expect(removeProfile.mock.calls).toEqual([[slotDir(root, 2)]]);
    expect(await readdir(publicRoot(root))).toEqual(["slot-1"]);
    await expect(broker.getPublicProfileStats()).resolves.toEqual({ profiles: 1, inUse: 0 });
  });
});

describe("sweep of unused public profiles", () => {
  const LEGACY_MAX_AGE_MS = 6 * HOUR_MS;
  const UNUSED_SLOT_MAX_AGE_MS = 14 * DAY_MS;

  /** Stops the clock at the present, so that ages are exact and a test can move an hour ahead. */
  function freezeClock(): number {
    vi.useFakeTimers({ toFake: ["Date"] });
    return Date.now();
  }

  it("removes the throwaway profiles of earlier versions once they are six hours old", async () => {
    freezeClock();
    const root = makeTestDir("browser-broker-sweep-legacy");
    const old = await makeAgedDirectory(root, "profile-0a1b2c3d", LEGACY_MAX_AGE_MS + MINUTE_MS);
    const young = await makeAgedDirectory(root, "profile-4e5f6a7b", LEGACY_MAX_AGE_MS - MINUTE_MS);
    const shutdownTarget = mockShutdown();
    const removeProfile = mockRemoveProfile();
    const broker = new BrowserBroker({ copilotHome: root, shutdownTarget, removeProfile });

    const lease = await broker.createSessionTarget("public");

    expect(lease.publicSlot).toBe(1);
    expect(removeProfile.mock.calls).toEqual([[old]]);
    expect(await exists(old)).toBe(false);
    await expect(readFile(join(young, "Preferences"), "utf-8")).resolves.toBe("{}");
    // No browser is looked for on a throwaway profile: only the leased one is checked.
    expect(closedSlots(shutdownTarget)).toEqual([1]);
  });

  it("removes a profile nothing has used for two weeks, after checking it for a leftover browser", async () => {
    freezeClock();
    const root = makeTestDir("browser-broker-sweep-unused");
    const unused = await makeAgedDirectory(root, "slot-5", UNUSED_SLOT_MAX_AGE_MS + MINUTE_MS);
    const recent = await makeAgedDirectory(root, "slot-6", UNUSED_SLOT_MAX_AGE_MS - MINUTE_MS);
    const events: string[] = [];
    const shutdownTarget = vi.fn<ShutdownTarget>(async (target) => {
      events.push(`close ${slotOf(target)}`);
      return successfulShutdown();
    });
    const removeProfile = vi.fn<RemoveProfile>(async (profileDir) => {
      events.push(`remove ${profileDir === unused ? "slot-5" : profileDir}`);
      await rm(profileDir, { recursive: true, force: true });
    });
    const broker = new BrowserBroker({ copilotHome: root, shutdownTarget, removeProfile });

    const lease = await broker.createSessionTarget("public");

    expect(lease.publicSlot).toBe(1);
    expect(events).toEqual(["close 5", "remove slot-5", "close 1"]);
    expect(await exists(unused)).toBe(false);
    await expect(readFile(join(recent, "Preferences"), "utf-8")).resolves.toBe("{}");
    await expect(broker.getPublicProfileStats()).resolves.toEqual({ profiles: 2, inUse: 1 });
  });

  it("keeps an unused profile whose leftover browser will not die", async () => {
    freezeClock();
    const root = makeTestDir("browser-broker-sweep-stuck");
    const unused = await makeAgedDirectory(root, "slot-5", UNUSED_SLOT_MAX_AGE_MS + DAY_MS);
    const shutdownTarget = mockShutdown((slot) => (slot === 5 ? shutdownLeaving(321) : successfulShutdown()));
    const removeProfile = mockRemoveProfile();
    const broker = new BrowserBroker({ copilotHome: root, shutdownTarget, removeProfile });

    const lease = await broker.createSessionTarget("public");

    expect(lease.publicSlot).toBe(1);
    expect(closedSlots(shutdownTarget)).toEqual([5, 1]);
    expect(removeProfile).not.toHaveBeenCalled();
    await expect(readFile(join(unused, "Preferences"), "utf-8")).resolves.toBe("{}");
    // It was held only for the check.
    await expect(broker.getPublicProfileStats()).resolves.toEqual({ profiles: 2, inUse: 1 });
  });

  it("does not remove an old profile that a browser is using", async () => {
    const startedAt = freezeClock();
    const root = makeTestDir("browser-broker-sweep-leased");
    const shutdownTarget = mockShutdown();
    const removeProfile = mockRemoveProfile();
    const broker = new BrowserBroker({ copilotHome: root, shutdownTarget, removeProfile });
    const held = await broker.createSessionTarget("public");
    await writeFile(join(held.browserTarget.profileDir, "Cookies"), "in use");
    // A browser that has been open for weeks without changing its profile's folder, and an idle
    // profile of the same age to show that the sweep did run.
    await setAge(held.browserTarget.profileDir, UNUSED_SLOT_MAX_AGE_MS + DAY_MS);
    const unused = await makeAgedDirectory(root, "slot-9", UNUSED_SLOT_MAX_AGE_MS + DAY_MS);
    vi.setSystemTime(startedAt + HOUR_MS + MINUTE_MS);

    const next = await broker.createSessionTarget("public");

    expect(next.publicSlot).toBe(2);
    expect(removeProfile.mock.calls).toEqual([[unused]]);
    await expect(readFile(join(held.browserTarget.profileDir, "Cookies"), "utf-8")).resolves.toBe("in use");
    // The held profile was not checked for a leftover browser either: that would close its browser.
    expect(closedSlots(shutdownTarget)).toEqual([1, 9, 2]);
  });

  it("leaves everything else in the folder alone", async () => {
    freezeClock();
    const root = makeTestDir("browser-broker-sweep-other");
    const age = UNUSED_SLOT_MAX_AGE_MS + 30 * DAY_MS;
    const directories = [
      await makeAgedDirectory(root, "other", age),
      await makeAgedDirectory(root, "profiles", age),
      await makeAgedDirectory(root, "slots", age),
      await makeAgedDirectory(root, "slot-x", age),
      await makeAgedDirectory(root, "slot-", age),
      await makeAgedDirectory(root, "slot-0", age),
      await makeAgedDirectory(root, "slot-02", age),
      await makeAgedDirectory(root, "slot-1e1", age),
      await makeAgedDirectory(root, "my-profile-0a1b2c3d", age),
    ];
    const files = [join(publicRoot(root), "profile-0a1b2c3d"), join(publicRoot(root), "slot-7")];
    for (const file of files) {
      await writeFile(file, "a file");
      await setAge(file, age);
    }
    const shutdownTarget = mockShutdown();
    const removeProfile = mockRemoveProfile();
    const broker = new BrowserBroker({ copilotHome: root, shutdownTarget, removeProfile });

    const lease = await broker.createSessionTarget("public");

    expect(lease.publicSlot).toBe(1);
    expect(removeProfile).not.toHaveBeenCalled();
    expect(closedSlots(shutdownTarget)).toEqual([1]);
    for (const directory of directories) {
      await expect(readFile(join(directory, "Preferences"), "utf-8")).resolves.toBe("{}");
    }
    for (const file of files) {
      await expect(readFile(file, "utf-8")).resolves.toBe("a file");
    }
  });

  it("sweeps at most once an hour", async () => {
    const startedAt = freezeClock();
    const root = makeTestDir("browser-broker-sweep-throttle");
    const removeProfile = mockRemoveProfile();
    const broker = new BrowserBroker({ copilotHome: root, shutdownTarget: mockShutdown(), removeProfile });
    const age = LEGACY_MAX_AGE_MS + HOUR_MS;

    const first = await makeAgedDirectory(root, "profile-00000001", age);
    await broker.createSessionTarget("public");
    expect(removeProfile.mock.calls).toEqual([[first]]);

    // Old enough from the start, yet the sweep has just run.
    const second = await makeAgedDirectory(root, "profile-00000002", age);
    await broker.createSessionTarget("public");
    vi.setSystemTime(startedAt + HOUR_MS - MINUTE_MS);
    await broker.createSessionTarget("public");
    expect(removeProfile).toHaveBeenCalledTimes(1);
    expect(await exists(second)).toBe(true);

    vi.setSystemTime(startedAt + HOUR_MS + MINUTE_MS);
    const lease = await broker.createSessionTarget("public");
    expect(lease.publicSlot).toBe(4);
    expect(removeProfile.mock.calls).toEqual([[first], [second]]);
    expect(await exists(second)).toBe(false);

    // And the hour starts again.
    const third = await makeAgedDirectory(root, "profile-00000003", age);
    vi.setSystemTime(startedAt + 2 * HOUR_MS);
    await broker.createSessionTarget("public");
    expect(removeProfile).toHaveBeenCalledTimes(2);
    expect(await exists(third)).toBe(true);
  });

  it("leases a profile even when an unused one cannot be removed, and removes the others", async () => {
    freezeClock();
    const root = makeTestDir("browser-broker-sweep-remove-fails");
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const busyLegacy = await makeAgedDirectory(root, "profile-0000busy", LEGACY_MAX_AGE_MS + HOUR_MS);
    const legacy = await makeAgedDirectory(root, "profile-0000free", LEGACY_MAX_AGE_MS + HOUR_MS);
    const busySlot = await makeAgedDirectory(root, "slot-8", UNUSED_SLOT_MAX_AGE_MS + DAY_MS);
    const slot = await makeAgedDirectory(root, "slot-9", UNUSED_SLOT_MAX_AGE_MS + DAY_MS);
    const removeProfile = vi.fn<RemoveProfile>(async (profileDir) => {
      if (profileDir === busyLegacy || profileDir === busySlot) {
        throw Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" });
      }
      await rm(profileDir, { recursive: true, force: true });
    });
    const broker = new BrowserBroker({
      copilotHome: root,
      shutdownTarget: mockShutdown(),
      removeProfile,
      // The sweep comes round again in an hour; it does not wait on a busy folder.
      profileRemoveRetryDelaysMs: [0, 0, 0],
    });

    const lease = await broker.createSessionTarget("public");

    expect(lease.publicSlot).toBe(1);
    // Each folder was tried once.
    expect(removeProfile).toHaveBeenCalledTimes(4);
    expect(await exists(legacy)).toBe(false);
    expect(await exists(slot)).toBe(false);
    expect(await exists(busyLegacy)).toBe(true);
    expect(await exists(busySlot)).toBe(true);
    // The profile that could not be removed is not left held.
    await expect(broker.getPublicProfileStats()).resolves.toEqual({ profiles: 2, inUse: 1 });
  });
});
