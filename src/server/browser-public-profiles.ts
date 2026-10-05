// The profiles of the public browsers: `browser-public/slot-N` folders that outlive the browsers
// started on them, so cookies and passed checks carry over from one use to the next. A profile
// is leased to one browser at a time.

import { createHash } from "node:crypto";
import { mkdir, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

import { browserIsGone, type BrowserLaunchConfig, type BrowserShutdownResult, type BrowserTarget } from "./agent-browser.js";

export interface PublicProfile {
  slot: number;
  browserTarget: BrowserTarget;
  /** The folder did not exist before this lease, so nothing in it can be in a browser's way. */
  isNew: boolean;
}

export interface PublicProfilePoolOptions {
  copilotHome: string;
  /** How long a public browser's daemon may idle before it closes the browser by itself. */
  daemonIdleTimeoutMs: number;
  getBrowserLaunchConfig: () => BrowserLaunchConfig;
  shutdownTarget: (target: BrowserTarget) => Promise<Parameters<typeof browserIsGone>[0]>;
  removeProfile: (profileDir: string) => Promise<void>;
  /**
   * Waits between attempts to remove a profile. A browser that had to be killed can keep files
   * of its profile open for a moment after its processes are gone.
   */
  removeRetryDelaysMs?: readonly number[];
}

const PROFILE_ROOT = "browser-public";
const SLOT_NAME = /^slot-([1-9]\d*)$/;
/** Folders of the throwaway profiles that public browsers used before they kept their profile. */
const LEGACY_PROFILE_PREFIX = "profile-";
/** More browsers than this at once means handles are leaking, not that more profiles are needed. */
const MAX_SLOTS = 32;
const LEGACY_PROFILE_MAX_AGE_MS = 6 * 60 * 60 * 1000;
/** A profile nothing has used for this long is removed; the lowest slots stay in use and warm. */
const UNUSED_SLOT_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;
const REMOVE_RETRY_DELAYS_MS = [100, 200, 400, 800, 1_500, 2_000] as const;

function slotOf(folderName: string): number | undefined {
  const slot = Number(SLOT_NAME.exec(folderName)?.[1]);
  return Number.isSafeInteger(slot) ? slot : undefined;
}

function warn(message: string, error: unknown): void {
  console.warn(`[browser] ${message}:`, error instanceof Error ? error.message : String(error));
}

export class PublicProfilePool {
  readonly root: string;
  /** Profiles a browser holds, or that are being checked or removed. */
  private readonly leased = new Set<number>();
  /** Profiles known to have no browser left over from an earlier use or server. */
  private readonly verified = new Set<number>();
  private readonly removeRetryDelaysMs: readonly number[];
  private nextSweepAt = 0;

  constructor(private readonly options: PublicProfilePoolOptions) {
    this.root = join(options.copilotHome, PROFILE_ROOT);
    this.removeRetryDelaysMs = options.removeRetryDelaysMs ?? REMOVE_RETRY_DELAYS_MS;
  }

  /**
   * Leases the lowest free profile, so one profile takes most of the traffic and stays the
   * warmest. With `unused`, only one that does not exist yet.
   */
  async lease(options: { unused?: boolean } = {}): Promise<PublicProfile> {
    await this.sweep();
    const existing = new Set(await this.list());
    for (let slot = 1; slot <= MAX_SLOTS; slot++) {
      if (this.leased.has(slot) || (options.unused && existing.has(slot))) continue;
      this.leased.add(slot);
      try {
        const browserTarget = this.targetOf(slot);
        if (await this.verify(slot, browserTarget)) {
          await mkdir(browserTarget.profileDir, { recursive: true });
          return { slot, browserTarget, isNew: !existing.has(slot) };
        }
      } catch (error) {
        this.leased.delete(slot);
        throw error;
      }
      // A browser from an earlier use still holds this profile and would not die.
      this.leased.delete(slot);
    }
    throw new Error("Every public browser profile is in use. Close a browser session and try again.");
  }

  /** Gives a leased profile back. */
  release(slot: number): void {
    this.leased.delete(slot);
  }

  /** The browser on the profile may not have closed, so it is checked for one before its next use. */
  markUnclean(slot: number): void {
    this.verified.delete(slot);
  }

  /**
   * Removes the folder of a profile no browser is using. False when one is, or when a leftover
   * browser on it could not be closed. With `retry` false the removal is tried once, for a
   * caller that has someone waiting.
   */
  async removeIfIdle(slot: number, options: { retry?: boolean } = {}): Promise<boolean> {
    if (this.leased.has(slot)) return false;
    // Held while it is removed, so no browser is started on a profile that is going away.
    this.leased.add(slot);
    try {
      const target = this.targetOf(slot);
      if (!await this.verify(slot, target)) return false;
      const delays = options.retry === false ? [] : this.removeRetryDelaysMs;
      for (let attempt = 0; ; attempt++) {
        try {
          await this.options.removeProfile(target.profileDir);
          return true;
        } catch (error) {
          if (attempt >= delays.length) throw error;
          await new Promise<void>((resolve) => setTimeout(resolve, delays[attempt]));
        }
      }
    } finally {
      this.leased.delete(slot);
    }
  }

  /** Removes the browsing data of every profile no browser is using. */
  async reset(): Promise<{ cleared: number; inUse: number }> {
    let cleared = 0;
    let inUse = 0;
    for (const slot of await this.list()) {
      let removed = false;
      try {
        removed = await this.removeIfIdle(slot);
      } catch (error) {
        // Its browser would not close or its files would not go: it is still in use, in effect.
        warn(`Failed to clear public profile ${slot}`, error);
      }
      if (removed) cleared += 1;
      else inUse += 1;
    }
    return { cleared, inUse };
  }

  /** How many profiles exist and how many a browser is using. */
  async stats(): Promise<{ profiles: number; inUse: number }> {
    const slots = await this.list();
    return { profiles: slots.length, inUse: slots.filter((slot) => this.leased.has(slot)).length };
  }

  private targetOf(slot: number): BrowserTarget {
    const launchConfig = this.options.getBrowserLaunchConfig();
    // Other Bridge instances on the host (a staged preview) number their profiles the same way.
    const instance = createHash("sha1").update(this.options.copilotHome).digest("hex").slice(0, 8);
    return {
      sessionName: `copilot-bridge-public-${instance}-${slot}`,
      profileDir: join(this.root, `slot-${slot}`),
      idleTimeoutMs: this.options.daemonIdleTimeoutMs,
      stopDaemonOnShutdown: true,
      ...(launchConfig.executablePath ? { executablePath: launchConfig.executablePath } : {}),
      ...(launchConfig.headed ? { headed: true } : {}),
    };
  }

  /**
   * Makes sure no browser is running on a profile before it is used or removed: one can be left
   * from a server that was killed or from a cleanup that failed. False when one is still there
   * afterwards.
   */
  private async verify(slot: number, target: BrowserTarget): Promise<boolean> {
    if (this.verified.has(slot)) return true;
    if (!browserIsGone(await this.options.shutdownTarget(target))) return false;
    this.verified.add(slot);
    return true;
  }

  private async list(): Promise<number[]> {
    try {
      const entries = await readdir(this.root, { withFileTypes: true });
      return entries
        .flatMap((entry) => (entry.isDirectory() ? slotOf(entry.name) ?? [] : []))
        .sort((a, b) => a - b);
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return [];
      throw error;
    }
  }

  /**
   * Removes profiles nothing has used for a long time, and the old throwaway ones. It runs in
   * front of a lease, so a folder that will not go is left for the next sweep.
   */
  private async sweep(now = Date.now()): Promise<void> {
    if (now < this.nextSweepAt) return;
    this.nextSweepAt = now + SWEEP_INTERVAL_MS;
    let names: string[];
    try {
      names = (await readdir(this.root, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") {
        warn("Failed to sweep unused public browser profiles", error);
      }
      return;
    }
    for (const name of names) {
      const slot = slotOf(name);
      const maxAgeMs = slot !== undefined
        ? UNUSED_SLOT_MAX_AGE_MS
        : name.startsWith(LEGACY_PROFILE_PREFIX) ? LEGACY_PROFILE_MAX_AGE_MS : undefined;
      if (maxAgeMs === undefined) continue;
      try {
        if (now - (await stat(join(this.root, name))).mtimeMs <= maxAgeMs) continue;
        if (slot !== undefined) await this.removeIfIdle(slot, { retry: false });
        else await this.options.removeProfile(join(this.root, name));
      } catch (error) {
        warn(`Failed to remove unused public profile ${name}`, error);
      }
    }
  }
}
