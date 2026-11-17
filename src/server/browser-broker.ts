import { randomUUID } from "node:crypto";

import type { AuthenticatedServiceCheck } from "../shared/browser-diagnostics.js";
import type { TelemetryStore } from "./telemetry-store.js";
import {
  ab,
  browserFailureAdvice,
  browserIsGone,
  getBridgeBrowserTarget,
  safeRecordBrowserSpan,
  shutdownBridgeBrowser,
  type BrowserCommand,
  type BrowserCommandOptions,
  type BrowserCommandResult,
  type BrowserLaunchConfig,
  type BrowserTarget,
} from "./agent-browser.js";
import { PublicProfilePool } from "./browser-public-profiles.js";
import { getProcessHost } from "./process-host.js";

export type BrowserContext = "public" | "authenticated";
export type BrowserContextStatus = "stopped" | "starting" | "ready" | "degraded" | "unavailable";

export interface BrowserContextHealth {
  context: BrowserContext;
  status: BrowserContextStatus;
  activeOperations: number;
  queuedOperations: number;
  lastProbeAt?: string;
  lastSuccessAt?: string;
  lastFailureAt?: string;
  lastError?: string;
}

export interface BrowserBrokerSnapshot {
  namespace: string;
  public: BrowserContextHealth & {
    profileRoot: string;
    maxConcurrency: number;
  };
  authenticated: BrowserContextHealth & {
    profileDirectory: string;
    headed: boolean;
  };
}

export interface BrowserBrokerLease {
  context: BrowserContext;
  browserTarget: BrowserTarget;
  /** The public profile the lease holds until it is disposed. Public leases only. */
  publicSlot?: number;
  /** The public profile is new to this lease, so nothing in it can block a browser. */
  publicProfileIsNew?: boolean;
}

export interface PublicProfileStats {
  profiles: number;
  inUse: number;
}

export interface BrowserBrokerOperationOptions {
  toolName: string;
  browserOpId: string;
  metadata?: Record<string, unknown>;
  skipReadiness?: boolean;
  /** Part of a person's work in a held browser (see holdTarget), so it runs during the hold. */
  duringHold?: boolean;
}

/** The browser would not start. Says nothing about a page. */
export class BrowserUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrowserUnavailableError";
  }
}

export interface BrowserBrokerOptions {
  /** The Bridge's data folder. Names its browsers too, so two Bridges on a host never share one. */
  copilotHome: string;
  telemetryStore?: TelemetryStore;
  getBrowserLaunchConfig?: () => BrowserLaunchConfig;
  /** Idle close for the signed-in browser, for a Bridge nothing takes over (such as a preview). */
  authenticatedIdleTimeoutMs?: number;
  publicConcurrency?: number;
  runCommand?: (
    command: BrowserCommand,
    timeout: number | undefined,
    options: BrowserCommandOptions,
  ) => Promise<BrowserCommandResult>;
  shutdownTarget?: (
    target: BrowserTarget,
    telemetryStore?: TelemetryStore,
  ) => Promise<Awaited<ReturnType<typeof shutdownBridgeBrowser>>>;
  removeProfile?: (profileDir: string) => Promise<void>;
  profileRemoveRetryDelaysMs?: readonly number[];
}

interface MutableBrowserContextHealth {
  status: BrowserContextStatus;
  activeOperations: number;
  queuedOperations: number;
  lastProbeAt?: string;
  lastSuccessAt?: string;
  lastFailureAt?: string;
  lastError?: string;
}

const BROWSER_NAMESPACE = "copilot-bridge";
const DEFAULT_PUBLIC_CONCURRENCY = 5;
const READINESS_TIMEOUT_MS = 45_000;
const READINESS_RETRY_DELAYS_MS = [250, 750, 1_500] as const;
/** How long a browser_session handle may go unused before the Bridge closes it. */
export const BROWSER_SESSION_IDLE_TIMEOUT_MS = 30 * 60_000;
/** Backstop for browsers the Bridge lost track of, so longer than the Bridge's own limit. */
export const PUBLIC_BROWSER_DAEMON_IDLE_TIMEOUT_MS = BROWSER_SESSION_IDLE_TIMEOUT_MS + 15 * 60_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toHealth(context: BrowserContext, state: MutableBrowserContextHealth): BrowserContextHealth {
  return {
    context,
    status: state.status,
    activeOperations: state.activeOperations,
    queuedOperations: state.queuedOperations,
    ...(state.lastProbeAt ? { lastProbeAt: state.lastProbeAt } : {}),
    ...(state.lastSuccessAt ? { lastSuccessAt: state.lastSuccessAt } : {}),
    ...(state.lastFailureAt ? { lastFailureAt: state.lastFailureAt } : {}),
    ...(state.lastError ? { lastError: state.lastError } : {}),
  };
}

export class BrowserBroker {
  readonly namespace = BROWSER_NAMESPACE;

  private readonly copilotHome: string;
  private readonly authenticatedIdleTimeoutMs: number | undefined;
  private readonly telemetryStore?: TelemetryStore;
  private readonly getBrowserLaunchConfig: () => BrowserLaunchConfig;
  private readonly publicConcurrency: number;
  private readonly runCommand: NonNullable<BrowserBrokerOptions["runCommand"]>;
  private readonly shutdownTarget: NonNullable<BrowserBrokerOptions["shutdownTarget"]>;
  private readonly publicProfiles: PublicProfilePool;
  private readonly publicWaiters: Array<() => void> = [];
  /** Browsers a person is acting in, by session name, with what they were asked to do. */
  private readonly heldTargets = new Map<string, { purpose: string }>();
  private readonly holdSuccessors = new Map<string, Set<() => void>>();
  private readonly targetTails = new Map<string, Promise<void>>();
  private publicAvailable: number;
  private authenticatedTail: Promise<void> = Promise.resolve();
  private authenticatedClosing = false;
  private readonly authenticatedServiceChecks = new Map<string, AuthenticatedServiceCheck>();
  private readonly health: Record<BrowserContext, MutableBrowserContextHealth> = {
    public: {
      status: "stopped",
      activeOperations: 0,
      queuedOperations: 0,
    },
    authenticated: {
      status: "stopped",
      activeOperations: 0,
      queuedOperations: 0,
    },
  };

  constructor(options: BrowserBrokerOptions) {
    this.copilotHome = options.copilotHome;
    this.authenticatedIdleTimeoutMs = options.authenticatedIdleTimeoutMs;
    this.telemetryStore = options.telemetryStore;
    this.getBrowserLaunchConfig = options.getBrowserLaunchConfig ?? (() => ({}));
    this.publicConcurrency = options.publicConcurrency ?? DEFAULT_PUBLIC_CONCURRENCY;
    this.publicAvailable = this.publicConcurrency;
    this.runCommand = options.runCommand ?? ((command, timeout, commandOptions) =>
      ab(command, timeout, commandOptions));
    this.shutdownTarget = options.shutdownTarget ?? shutdownBridgeBrowser;
    this.publicProfiles = new PublicProfilePool({
      copilotHome: this.copilotHome,
      daemonIdleTimeoutMs: PUBLIC_BROWSER_DAEMON_IDLE_TIMEOUT_MS,
      getBrowserLaunchConfig: this.getBrowserLaunchConfig,
      shutdownTarget: (target) => this.shutdownTarget(target, this.telemetryStore),
      removeProfile: options.removeProfile ?? ((profileDir) => getProcessHost().removeTree(profileDir)),
      removeRetryDelaysMs: options.profileRemoveRetryDelaysMs,
    });
  }

  getAuthenticatedTarget(): BrowserTarget {
    const target = getBridgeBrowserTarget(this.copilotHome, this.getBrowserLaunchConfig());
    return this.authenticatedIdleTimeoutMs === undefined ? target : { ...target, idleTimeoutMs: this.authenticatedIdleTimeoutMs };
  }

  getSnapshot(): BrowserBrokerSnapshot {
    const authenticatedTarget = this.getAuthenticatedTarget();
    return {
      namespace: this.namespace,
      public: {
        ...toHealth("public", this.health.public),
        profileRoot: this.publicProfiles.root,
        maxConcurrency: this.publicConcurrency,
      },
      authenticated: {
        ...toHealth("authenticated", this.health.authenticated),
        profileDirectory: authenticatedTarget.profileDir,
        headed: authenticatedTarget.headed === true,
      },
    };
  }

  getAuthenticatedServiceChecks(): AuthenticatedServiceCheck[] {
    return [...this.authenticatedServiceChecks.values()];
  }

  recordAuthenticatedServiceCheck(check: AuthenticatedServiceCheck): void {
    this.authenticatedServiceChecks.set(check.service, { ...check });
  }

  /** Runs one operation in a browser closed afterwards; a public one keeps its profile. */
  async withEphemeralContext<T>(
    context: BrowserContext,
    options: BrowserBrokerOperationOptions,
    fn: (lease: BrowserBrokerLease) => Promise<T>,
  ): Promise<T> {
    if (context === "authenticated") {
      const target = this.getAuthenticatedTarget();
      return this.withTarget({ context, browserTarget: target }, options, fn);
    }

    // Capacity first: a call that is only waiting its turn holds no profile.
    const release = await this.acquirePublic();
    try {
      const first = await this.runEphemeralPublic(options, fn, false);
      if (first.ok) return first.value;
      if (!(first.failure instanceof BrowserUnavailableError)) throw first.failure;
      if (first.profileIsNew) {
        // The host cannot start browsers; drop the folder or every failed call leaves one.
        await this.discardPublicProfile(first.slot, options);
        throw first.failure;
      }
      // Retry on an unused profile: failing again blames the host, starting blames the old profile.
      const second = await this.runEphemeralPublic(options, fn, true);
      const startedOnUnused = second.ok || !(second.failure instanceof BrowserUnavailableError);
      await this.discardPublicProfile(startedOnUnused ? first.slot : second.slot, options);
      if (second.ok) return second.value;
      throw startedOnUnused ? second.failure : first.failure;
    } finally {
      release();
    }
  }

  private async runEphemeralPublic<T>(
    options: BrowserBrokerOperationOptions,
    fn: (lease: BrowserBrokerLease) => Promise<T>,
    unused: boolean,
  ): Promise<
    | { ok: true; value: T; slot: number }
    | { ok: false; failure: unknown; slot: number; profileIsNew: boolean }
  > {
    const lease = await this.createSessionTarget("public", { unused });
    const slot = lease.publicSlot!;
    let outcome: Awaited<ReturnType<typeof this.runEphemeralPublic<T>>>;
    try {
      outcome = { ok: true, value: await this.runOnTarget(lease, options, fn), slot };
    } catch (failure) {
      outcome = { ok: false, failure, slot, profileIsNew: lease.publicProfileIsNew === true };
    }
    try {
      await this.disposeSessionTarget(lease, {
        toolName: options.toolName,
        browserOpId: options.browserOpId,
        metadata: options.metadata,
      });
    } catch (cleanupError) {
      // The operation's outcome stands; drop the profile, it's checked before reuse and idles out.
      this.publicProfiles.release(slot);
      console.error(
        `[browser] Public browser cleanup failed after the operation ${outcome.ok ? "succeeded" : "failed"}:`,
        cleanupError,
      );
    }
    return outcome;
  }

  /** Removes a public profile no browser should start on again, unless it was taken meanwhile. */
  private async discardPublicProfile(slot: number, options: BrowserBrokerOperationOptions): Promise<void> {
    let removed = false;
    try {
      removed = await this.publicProfiles.removeIfIdle(slot);
    } catch (error) {
      console.warn(
        `[browser] Failed to remove public profile ${slot}, on which the browser does not start:`,
        error instanceof Error ? error.message : String(error),
      );
    }
    safeRecordBrowserSpan(this.telemetryStore, "browser.public.profile_reset", 0, {
      browserOpId: options.browserOpId,
      toolName: options.toolName,
      publicSlot: slot,
      removed,
    });
  }

  /** A target kept across operations; a public one holds its own profile until disposed. */
  async createSessionTarget(
    context: BrowserContext,
    options: { unused?: boolean } = {},
  ): Promise<BrowserBrokerLease> {
    if (context === "authenticated") {
      return {
        context,
        browserTarget: this.getAuthenticatedTarget(),
      };
    }

    const profile = await this.publicProfiles.lease(options);
    return {
      context,
      publicSlot: profile.slot,
      publicProfileIsNew: profile.isNew,
      browserTarget: profile.browserTarget,
    };
  }

  /** Throws if the browser won't close cleanly; the caller keeps the profile and may retry. */
  async disposeSessionTarget(
    lease: BrowserBrokerLease,
    options: BrowserBrokerOperationOptions,
  ): Promise<void> {
    const slot = lease.publicSlot;
    if (lease.context === "authenticated" || slot === undefined) return;

    const startedAt = Date.now();
    let shutdown: Awaited<ReturnType<typeof shutdownBridgeBrowser>> | undefined;
    let shutdownError: unknown;
    try {
      shutdown = await this.shutdownTarget(lease.browserTarget, this.telemetryStore);
    } catch (error) {
      shutdownError = error;
    }
    this.heldTargets.delete(lease.browserTarget.sessionName);
    const closed = !shutdownError && !!shutdown && browserIsGone(shutdown);
    if (closed) {
      this.publicProfiles.release(slot);
    } else {
      // The caller still holds the profile and may try again; nothing else is given it meanwhile.
      this.publicProfiles.markUnclean(slot);
    }

    safeRecordBrowserSpan(this.telemetryStore, "browser.public.cleanup", Date.now() - startedAt, {
      browserOpId: options.browserOpId,
      toolName: options.toolName,
      browserContext: lease.context,
      publicSlot: slot,
      closeOk: shutdown?.closeOk,
      remainingPids: shutdown?.remainingPids,
      shutdownOk: !shutdownError,
      ...options.metadata,
    });

    if (shutdownError) throw shutdownError;
    if (!closed) {
      throw new Error(shutdown?.remainingPids.length
        ? `Public browser processes remained after cleanup: ${shutdown.remainingPids.join(", ")}`
        : "The public browser did not confirm that it closed, and the host's processes could not be listed.");
    }
  }

  /** Lends the browser to a person until the returned fn runs; others fail fast. Throws if held. */
  holdTarget(lease: BrowserBrokerLease, purpose: string): () => void {
    const sessionName = lease.browserTarget.sessionName;
    this.assertNotHeld(lease, {});
    const hold = { purpose };
    this.heldTargets.set(sessionName, hold);
    return () => {
      if (this.heldTargets.get(sessionName) !== hold) return;
      this.heldTargets.delete(sessionName);
      const next = this.holdSuccessors.get(sessionName);
      this.holdSuccessors.delete(sessionName);
      // In the same breath, so that nothing gets at the browser in between.
      for (const take of next ?? []) take();
    };
  }

  /** Runs `take` as the current hold ends, before anything else can have the browser. */
  afterHold(lease: BrowserBrokerLease, take: () => void): () => void {
    const sessionName = lease.browserTarget.sessionName;
    const waiting = this.holdSuccessors.get(sessionName) ?? new Set<() => void>();
    waiting.add(take);
    this.holdSuccessors.set(sessionName, waiting);
    return () => {
      waiting.delete(take);
      if (waiting.size === 0 && this.holdSuccessors.get(sessionName) === waiting) this.holdSuccessors.delete(sessionName);
    };
  }

  /** What the user was given a browser for, while they have it. */
  heldFor(lease: BrowserBrokerLease): string | undefined {
    return this.heldTargets.get(lease.browserTarget.sessionName)?.purpose;
  }

  /** How many public profiles exist and how many a browser is using. */
  getPublicProfileStats(): Promise<PublicProfileStats> {
    return this.publicProfiles.stats();
  }

  /** Removes the browsing data of every public profile no browser is using. */
  async resetPublicProfiles(): Promise<{ cleared: number; inUse: number }> {
    const result = await this.publicProfiles.reset();
    safeRecordBrowserSpan(this.telemetryStore, "browser.public.reset", 0, result);
    return result;
  }

  async withTarget<T>(
    lease: BrowserBrokerLease,
    options: BrowserBrokerOperationOptions,
    fn: (lease: BrowserBrokerLease) => Promise<T>,
  ): Promise<T> {
    this.assertNotHeld(lease, options);
    const release = lease.context === "authenticated"
      ? await this.acquireAuthenticated()
      : await this.acquirePublic();
    try {
      return await this.runOnTarget(lease, options, fn);
    } finally {
      release();
    }
  }

  private assertNotHeld(lease: BrowserBrokerLease, options: { duringHold?: boolean }): void {
    const hold = options.duringHold ? undefined : this.heldTargets.get(lease.browserTarget.sessionName);
    if (!hold) return;
    throw new Error(
      `The user has this browser right now (${hold.purpose}). Try again after they hand it back.`,
    );
  }

  /** Runs an operation on a target whose context capacity the caller already holds. */
  private async runOnTarget<T>(
    lease: BrowserBrokerLease,
    options: BrowserBrokerOperationOptions,
    fn: (lease: BrowserBrokerLease) => Promise<T>,
  ): Promise<T> {
    const releaseTarget = await this.acquireTarget(lease.browserTarget.sessionName);
    try {
      // Checked after taking the target: it may have been handed to the user while this waited.
      this.assertNotHeld(lease, options);
    } catch (error) {
      releaseTarget();
      throw error;
    }
    const state = this.health[lease.context];
    state.activeOperations += 1;
    try {
      if (!options.skipReadiness) {
        await this.ensureReady(lease, options);
      } else if (state.status !== "ready") {
        state.status = "starting";
      }
      const value = await fn(lease);
      if (options.skipReadiness) {
        state.lastSuccessAt = new Date().toISOString();
        state.lastError = undefined;
      } else {
        this.markSuccess(lease.context);
      }
      return value;
    } catch (error) {
      this.markFailure(lease.context, error);
      throw error;
    } finally {
      state.activeOperations = Math.max(0, state.activeOperations - 1);
      releaseTarget();
    }
  }

  /** Starts a browser of the context and reports its health; `inBrowser` runs once it is up. */
  async probe(
    context: BrowserContext,
    inBrowser: (lease: BrowserBrokerLease) => Promise<unknown> = async () => undefined,
  ): Promise<BrowserContextHealth> {
    const browserOpId = randomUUID();
    try {
      await this.withEphemeralContext(context, {
        toolName: "browser_diagnostics_probe",
        browserOpId,
      }, inBrowser);
    } catch {
      // The health state carries the exact failure for diagnostics.
    }
    return toHealth(context, this.health[context]);
  }

  async shutdownAuthenticated(headed = false): Promise<Awaited<ReturnType<typeof shutdownBridgeBrowser>>> {
    if (this.authenticatedClosing) {
      throw new Error("Authenticated browser shutdown is already in progress");
    }
    this.authenticatedClosing = true;
    const release = await this.acquireAuthenticated(true);
    try {
      const target = this.getAuthenticatedTarget();
      const result = await this.shutdownTarget(
        headed ? { ...target, headed: true } : target,
        this.telemetryStore,
      );
      const state = this.health.authenticated;
      if (result.ok) {
        state.status = "stopped";
        state.lastProbeAt = undefined;
        state.lastError = undefined;
      } else {
        state.status = "degraded";
        state.lastFailureAt = new Date().toISOString();
        state.lastError = result.outputSummary ?? result.failureCode ?? "Authenticated browser shutdown failed";
      }
      return result;
    } finally {
      release();
      this.authenticatedClosing = false;
    }
  }

  private async ensureReady(
    lease: BrowserBrokerLease,
    options: BrowserBrokerOperationOptions,
  ): Promise<void> {
    const state = this.health[lease.context];
    state.status = "starting";
    state.lastProbeAt = new Date().toISOString();
    const startedAt = Date.now();
    let lastOutput = "";

    for (let attempt = 0; attempt <= READINESS_RETRY_DELAYS_MS.length; attempt++) {
      if (attempt > 0) {
        await delay(READINESS_RETRY_DELAYS_MS[attempt - 1]);
      }
      const commandOptions: BrowserCommandOptions = {
        telemetryStore: this.telemetryStore,
        toolName: options.toolName,
        browserOpId: options.browserOpId,
        browserTarget: lease.browserTarget,
        metadata: {
          browserContext: lease.context,
          publicSlot: lease.publicSlot,
          readinessAttempt: attempt + 1,
          ...options.metadata,
        },
      };
      // Not URL or title: they run page JS, which a modal pauses, locking the caller out of it.
      const first = await this.runCommand(["tab", "list"], READINESS_TIMEOUT_MS, commandOptions);
      if (!first.ok) {
        lastOutput = first.output;
        continue;
      }
      const second = await this.runCommand(["dialog", "status"], READINESS_TIMEOUT_MS, commandOptions);
      if (!second.ok) {
        lastOutput = second.output;
        continue;
      }

      state.status = "ready";
      state.lastSuccessAt = new Date().toISOString();
      state.lastError = undefined;
      safeRecordBrowserSpan(this.telemetryStore, "browser.broker.readiness", Date.now() - startedAt, {
        browserOpId: options.browserOpId,
        toolName: options.toolName,
        browserContext: lease.context,
        publicSlot: lease.publicSlot,
        success: true,
        attempts: attempt + 1,
        ...options.metadata,
      });
      return;
    }

    const message = browserFailureAdvice(lastOutput)
      ?? (lastOutput.trim() || "agent-browser did not complete the readiness handshake");
    state.status = "unavailable";
    state.lastFailureAt = new Date().toISOString();
    state.lastError = message.slice(0, 500);
    safeRecordBrowserSpan(this.telemetryStore, "browser.broker.readiness", Date.now() - startedAt, {
      browserOpId: options.browserOpId,
      toolName: options.toolName,
      browserContext: lease.context,
      publicSlot: lease.publicSlot,
      success: false,
      error: state.lastError,
      ...options.metadata,
    });
    throw new BrowserUnavailableError(`Browser ${lease.context} context is unavailable: ${message.slice(0, 300)}`);
  }

  private markSuccess(context: BrowserContext): void {
    const state = this.health[context];
    state.status = "ready";
    state.lastSuccessAt = new Date().toISOString();
    state.lastError = undefined;
  }

  private markFailure(context: BrowserContext, error: unknown): void {
    const state = this.health[context];
    if (state.status !== "unavailable") state.status = "degraded";
    state.lastFailureAt = new Date().toISOString();
    state.lastError = (error instanceof Error ? error.message : String(error)).slice(0, 500);
  }

  private async acquireAuthenticated(allowClosing = false): Promise<() => void> {
    const state = this.health.authenticated;
    const rejectedForClosing = this.authenticatedClosing && !allowClosing;
    state.queuedOperations += 1;
    const previous = this.authenticatedTail;
    let releaseQueue!: () => void;
    this.authenticatedTail = new Promise<void>((resolve) => {
      releaseQueue = resolve;
    });
    await previous;
    state.queuedOperations = Math.max(0, state.queuedOperations - 1);
    if (rejectedForClosing || (this.authenticatedClosing && !allowClosing)) {
      releaseQueue();
      throw new Error("Authenticated browser is closing");
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      releaseQueue();
    };
  }

  private async acquireTarget(sessionName: string): Promise<() => void> {
    const previous = this.targetTails.get(sessionName) ?? Promise.resolve();
    let releaseQueue!: () => void;
    const current = new Promise<void>((resolve) => {
      releaseQueue = resolve;
    });
    this.targetTails.set(sessionName, current);
    await previous.catch(() => undefined);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      releaseQueue();
      if (this.targetTails.get(sessionName) === current) {
        this.targetTails.delete(sessionName);
      }
    };
  }

  private async acquirePublic(): Promise<() => void> {
    const state = this.health.public;
    if (this.publicAvailable <= 0) {
      state.queuedOperations += 1;
      await new Promise<void>((resolve) => this.publicWaiters.push(resolve));
      state.queuedOperations = Math.max(0, state.queuedOperations - 1);
    } else {
      this.publicAvailable -= 1;
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const waiter = this.publicWaiters.shift();
      if (waiter) {
        waiter();
      } else {
        this.publicAvailable = Math.min(this.publicConcurrency, this.publicAvailable + 1);
      }
    };
  }
}
