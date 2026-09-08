import { randomUUID } from "node:crypto";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { AuthenticatedServiceCheck } from "../shared/browser-diagnostics.js";
import type { TelemetryStore } from "./telemetry-store.js";
import {
  ab,
  getBridgeBrowserTarget,
  safeRecordBrowserSpan,
  shutdownBridgeBrowser,
  type BrowserCommand,
  type BrowserCommandOptions,
  type BrowserLaunchConfig,
  type BrowserTarget,
} from "./agent-browser.js";

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
  publicTargetId?: string;
}

export interface BrowserBrokerOperationOptions {
  toolName: string;
  browserOpId: string;
  metadata?: Record<string, unknown>;
  skipReadiness?: boolean;
}

export interface BrowserBrokerOptions {
  copilotHome?: string;
  telemetryStore?: TelemetryStore;
  getBrowserLaunchConfig?: () => BrowserLaunchConfig;
  publicConcurrency?: number;
  runCommand?: (
    command: BrowserCommand,
    timeout: number | undefined,
    options: BrowserCommandOptions,
  ) => Promise<{ ok: boolean; output: string }>;
  shutdownTarget?: (
    target: BrowserTarget,
    telemetryStore?: TelemetryStore,
  ) => Promise<Awaited<ReturnType<typeof shutdownBridgeBrowser>>>;
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
const PUBLIC_PROFILE_ROOT = "browser-public";
const DEFAULT_PUBLIC_CONCURRENCY = 5;
const READINESS_TIMEOUT_MS = 45_000;
const READINESS_RETRY_DELAYS_MS = [250, 750, 1_500] as const;
const STALE_PUBLIC_PROFILE_MAX_AGE_MS = 6 * 60 * 60 * 1000;

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
  private readonly telemetryStore?: TelemetryStore;
  private readonly getBrowserLaunchConfig: () => BrowserLaunchConfig;
  private readonly publicConcurrency: number;
  private readonly runCommand: NonNullable<BrowserBrokerOptions["runCommand"]>;
  private readonly shutdownTarget: NonNullable<BrowserBrokerOptions["shutdownTarget"]>;
  private readonly publicWaiters: Array<() => void> = [];
  private readonly activePublicProfiles = new Set<string>();
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

  constructor(options: BrowserBrokerOptions = {}) {
    this.copilotHome = options.copilotHome ?? process.env.COPILOT_HOME ?? join(homedir(), ".copilot");
    this.telemetryStore = options.telemetryStore;
    this.getBrowserLaunchConfig = options.getBrowserLaunchConfig ?? (() => ({}));
    this.publicConcurrency = options.publicConcurrency ?? DEFAULT_PUBLIC_CONCURRENCY;
    this.publicAvailable = this.publicConcurrency;
    this.runCommand = options.runCommand ?? ((command, timeout, commandOptions) =>
      ab(command, timeout, commandOptions));
    this.shutdownTarget = options.shutdownTarget ?? shutdownBridgeBrowser;
  }

  getAuthenticatedTarget(): BrowserTarget {
    return getBridgeBrowserTarget(this.copilotHome, this.getBrowserLaunchConfig());
  }

  getSnapshot(): BrowserBrokerSnapshot {
    const authenticatedTarget = this.getAuthenticatedTarget();
    return {
      namespace: this.namespace,
      public: {
        ...toHealth("public", this.health.public),
        profileRoot: this.getPublicProfileRoot(),
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

  async withEphemeralContext<T>(
    context: BrowserContext,
    options: BrowserBrokerOperationOptions,
    fn: (lease: BrowserBrokerLease) => Promise<T>,
  ): Promise<T> {
    if (context === "authenticated") {
      const target = this.getAuthenticatedTarget();
      return this.withTarget({ context, browserTarget: target }, options, fn);
    }

    const lease = await this.createSessionTarget("public");
    let operationError: unknown;
    try {
      return await this.withTarget(lease, options, fn);
    } catch (error) {
      operationError = error;
      throw error;
    } finally {
      try {
        await this.disposeSessionTarget(lease, {
          toolName: options.toolName,
          browserOpId: options.browserOpId,
          metadata: options.metadata,
        });
      } catch (cleanupError) {
        if (!operationError) throw cleanupError;
        console.error("[browser] Public browser cleanup failed after operation failure:", cleanupError);
      }
    }
  }

  async createSessionTarget(context: BrowserContext): Promise<BrowserBrokerLease> {
    if (context === "authenticated") {
      return {
        context,
        browserTarget: this.getAuthenticatedTarget(),
      };
    }

    const publicTargetId = randomUUID().slice(0, 8);
    const profileDir = join(this.getPublicProfileRoot(), `profile-${publicTargetId}`);
    await this.cleanupStalePublicProfiles();
    await mkdir(profileDir, { recursive: true });
    this.activePublicProfiles.add(profileDir);
    const launchConfig = this.getBrowserLaunchConfig();
    return {
      context,
      publicTargetId,
      browserTarget: {
        sessionName: `copilot-bridge-public-${publicTargetId}`,
        profileDir,
        ...(launchConfig.executablePath ? { executablePath: launchConfig.executablePath } : {}),
      },
    };
  }

  async disposeSessionTarget(
    lease: BrowserBrokerLease,
    options: BrowserBrokerOperationOptions,
  ): Promise<void> {
    if (lease.context === "authenticated") return;

    const startedAt = Date.now();
    let shutdown: Awaited<ReturnType<typeof shutdownBridgeBrowser>> | undefined;
    let shutdownError: unknown;
    let removeError: unknown;
    try {
      shutdown = await this.shutdownTarget(lease.browserTarget, this.telemetryStore);
    } catch (error) {
      shutdownError = error;
    } finally {
      try {
        await rm(lease.browserTarget.profileDir, { recursive: true, force: true });
      } catch (error) {
        removeError = error;
      } finally {
        this.activePublicProfiles.delete(lease.browserTarget.profileDir);
      }
    }

    safeRecordBrowserSpan(this.telemetryStore, "browser.public.cleanup", Date.now() - startedAt, {
      browserOpId: options.browserOpId,
      toolName: options.toolName,
      browserContext: lease.context,
      publicTargetId: lease.publicTargetId,
      closeOk: shutdown?.closeOk,
      remainingPids: shutdown?.remainingPids,
      shutdownOk: !shutdownError,
      removeOk: !removeError,
      ...options.metadata,
    });

    if (shutdownError && removeError) {
      throw new AggregateError(
        [shutdownError, removeError],
        "Public browser shutdown and profile removal both failed",
      );
    }
    if (shutdownError) {
      throw shutdownError;
    }
    if (removeError) {
      throw new Error(
        `Failed to remove public browser profile: ${
          removeError instanceof Error ? removeError.message : String(removeError)
        }`,
      );
    }
    if (shutdown && shutdown.remainingPids.length > 0) {
      throw new Error(
        `Public browser processes remained after cleanup: ${shutdown.remainingPids.join(", ")}`,
      );
    }
  }

  async withTarget<T>(
    lease: BrowserBrokerLease,
    options: BrowserBrokerOperationOptions,
    fn: (lease: BrowserBrokerLease) => Promise<T>,
  ): Promise<T> {
    const release = lease.context === "authenticated"
      ? await this.acquireAuthenticated()
      : await this.acquirePublic();
    const releaseTarget = await this.acquireTarget(lease.browserTarget.sessionName);
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
      release();
    }
  }

  async probe(context: BrowserContext, toolName = "browser_diagnostics_probe"): Promise<BrowserContextHealth> {
    const browserOpId = randomUUID();
    try {
      await this.withEphemeralContext(context, {
        toolName,
        browserOpId,
      }, async () => undefined);
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

  private getPublicProfileRoot(): string {
    return join(this.copilotHome, PUBLIC_PROFILE_ROOT);
  }

  private async cleanupStalePublicProfiles(): Promise<void> {
    const root = this.getPublicProfileRoot();
    try {
      const entries = await readdir(root, { withFileTypes: true });
      const now = Date.now();
      await Promise.all(entries.map(async (entry) => {
        if (!entry.isDirectory() || !entry.name.startsWith("profile-")) return;
        const profileDir = join(root, entry.name);
        if (this.activePublicProfiles.has(profileDir)) return;
        try {
          const profileStat = await stat(profileDir);
          if ((now - profileStat.mtimeMs) > STALE_PUBLIC_PROFILE_MAX_AGE_MS) {
            await rm(profileDir, { recursive: true, force: true });
          }
        } catch (error) {
          console.warn(
            `[browser] Failed to inspect stale public profile ${entry.name}:`,
            error instanceof Error ? error.message : String(error),
          );
        }
      }));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code !== "ENOENT") {
        console.warn(
          "[browser] Failed to sweep stale public browser profiles:",
          error instanceof Error ? error.message : String(error),
        );
      }
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
          publicTargetId: lease.publicTargetId,
          readinessAttempt: attempt + 1,
          ...options.metadata,
        },
      };
      const first = await this.runCommand(["get", "url"], READINESS_TIMEOUT_MS, commandOptions);
      if (!first.ok) {
        lastOutput = first.output;
        continue;
      }
      const second = await this.runCommand(["get", "title"], READINESS_TIMEOUT_MS, commandOptions);
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
        publicTargetId: lease.publicTargetId,
        success: true,
        attempts: attempt + 1,
        ...options.metadata,
      });
      return;
    }

    const message = lastOutput.trim() || "agent-browser did not complete the readiness handshake";
    state.status = "unavailable";
    state.lastFailureAt = new Date().toISOString();
    state.lastError = message.slice(0, 500);
    safeRecordBrowserSpan(this.telemetryStore, "browser.broker.readiness", Date.now() - startedAt, {
      browserOpId: options.browserOpId,
      toolName: options.toolName,
      browserContext: lease.context,
      publicTargetId: lease.publicTargetId,
      success: false,
      error: state.lastError,
      ...options.metadata,
    });
    throw new Error(`Browser ${lease.context} context is unavailable: ${message.slice(0, 200)}`);
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

const browserBrokers = new WeakMap<object, BrowserBroker>();

export function getOrCreateBrowserBroker(
  key: object,
  options: BrowserBrokerOptions = {},
): BrowserBroker {
  const existing = browserBrokers.get(key);
  if (existing) return existing;
  const broker = new BrowserBroker(options);
  browserBrokers.set(key, broker);
  return broker;
}
