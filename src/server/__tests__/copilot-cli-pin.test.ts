import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import {
  BRIDGE_COPILOT_CLI_CACHE_DIR_ENV,
  checkPinnedCopilotCliDir,
  COPILOT_CLI_LOCK_FILENAME,
  describeCopilotCliResolution,
  ensurePinnedCopilotCli,
  getCopilotCliPlatformKey,
  getCopilotCliReleaseAssetUrl,
  getPinnedCopilotCliDir,
  parseCopilotCliLock,
  PINNED_COPILOT_CLI_MARKER,
  prunePinnedCopilotCliCache,
  readCopilotCliLock,
  readPinnedCopilotCliMarker,
  resetCopilotCliRuntimeStatusForTests,
  resolveCopilotCliCacheDir,
  resolveCopilotCliForLaunch,
  type CopilotCliLock,
} from "../copilot-cli-pin.js";
import { makeTestDir } from "./helpers.js";

const VERSION = "1.0.81-6";
const PLATFORM = "win32-x64" as const;
const ASSET_NAME = `github-copilot-${VERSION}-${PLATFORM}.tgz`;

function sha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

/** Build a release-shaped tarball (package/ root) with the system tar. */
function buildReleaseTarball(dir: string, options: { version?: string; omit?: string[] } = {}): Buffer {
  const stage = join(dir, "stage");
  const pkg = join(stage, "package");
  mkdirSync(join(pkg, "prebuilds", PLATFORM), { recursive: true });
  const files: Record<string, string> = {
    "package.json": JSON.stringify({ name: "@github/copilot", version: options.version ?? VERSION }),
    "app.js": "export const app = true;\n",
    "index.js": "export const index = true;\n",
    [join("prebuilds", PLATFORM, "runtime.node")]: "not really native\n",
  };
  for (const [name, content] of Object.entries(files)) {
    if (options.omit?.includes(name)) continue;
    writeFileSync(join(pkg, name), content);
  }
  const tarball = join(dir, ASSET_NAME);
  execFileSync("tar", ["-czf", tarball, "-C", stage, "package"], { stdio: "pipe" });
  return readFileSync(tarball);
}

function writeLock(rootDir: string, lock: unknown): void {
  writeFileSync(join(rootDir, COPILOT_CLI_LOCK_FILENAME), JSON.stringify(lock));
}

function releaseLock(sha: string, version = VERSION): CopilotCliLock {
  return {
    source: "github-release",
    version,
    assets: { [PLATFORM]: { name: `github-copilot-${version}-${PLATFORM}.tgz`, sha256: sha } },
  };
}

function downloaderFor(expectedUrl: string, bytes: Buffer, calls: string[] = []) {
  return async (url: string) => {
    calls.push(url);
    if (url !== expectedUrl) throw new Error(`unexpected download ${url}`);
    return Readable.from([bytes]);
  };
}

afterEach(() => {
  resetCopilotCliRuntimeStatusForTests();
});

describe("copilot-cli lock parsing", () => {
  it("accepts the github-release shape", () => {
    expect(parseCopilotCliLock(JSON.stringify(releaseLock("a".repeat(64))))).toEqual(releaseLock("a".repeat(64)));
  });

  it("requires the lock to be present", () => {
    const root = makeTestDir("cli-lock-missing");
    expect(() => readCopilotCliLock(root)).toThrow(/is missing/);
  });

  it("rejects malformed locks loudly", () => {
    expect(() => parseCopilotCliLock("nope")).toThrow(/not valid JSON/);
    expect(() => parseCopilotCliLock('{"source":"npm"}')).toThrow(/source must be "github-release"/);
    expect(() => parseCopilotCliLock('{"source":"tarball"}')).toThrow(/source must be/);
    expect(() => parseCopilotCliLock('{"source":"github-release","version":"latest","assets":{}}')).toThrow(/version must be/);
    expect(() => parseCopilotCliLock('{"source":"github-release","version":"1.0.81-6","assets":{}}')).toThrow(/assets must map/);
    expect(() => parseCopilotCliLock(JSON.stringify({
      source: "github-release",
      version: VERSION,
      assets: { "plan9-mips": { name: ASSET_NAME, sha256: "a".repeat(64) } },
    }))).toThrow(/unknown platform key/);
    expect(() => parseCopilotCliLock(JSON.stringify({
      source: "github-release",
      version: VERSION,
      assets: { [PLATFORM]: { name: "../evil.tgz", sha256: "a".repeat(64) } },
    }))).toThrow(/needs a \.tgz name/);
    expect(() => parseCopilotCliLock(JSON.stringify({
      source: "github-release",
      version: VERSION,
      assets: { [PLATFORM]: { name: ASSET_NAME, sha256: "ABC" } },
    }))).toThrow(/lowercase hex sha256/);
  });

  it("derives platform keys and the release asset URL", () => {
    expect(getCopilotCliPlatformKey("win32", "x64")).toBe("win32-x64");
    expect(getCopilotCliPlatformKey("linux", "arm64")).toBe("linux-arm64");
    expect(getCopilotCliPlatformKey("linux", "x64", { musl: true })).toBe("linuxmusl-x64");
    expect(getCopilotCliPlatformKey("darwin", "arm64")).toBe("darwin-arm64");
    expect(() => getCopilotCliPlatformKey("sunos", "x64")).toThrow(/Unsupported/);
    expect(getCopilotCliReleaseAssetUrl(VERSION, ASSET_NAME)).toBe(
      `https://github.com/github/copilot-cli/releases/download/v${VERSION}/${ASSET_NAME}`,
    );
  });

  it("resolves the cache dir from the env override or under the data dir", () => {
    const dataDir = join("C:", "bridge", "data");
    expect(resolveCopilotCliCacheDir({}, dataDir)).toBe(join(dataDir, "copilot-cli"));
    const override = join("D:", "cli-cache");
    expect(resolveCopilotCliCacheDir({ [BRIDGE_COPILOT_CLI_CACHE_DIR_ENV]: override }, dataDir)).toBe(override);
    expect(resolveCopilotCliCacheDir({ [BRIDGE_COPILOT_CLI_CACHE_DIR_ENV]: "   " }, dataDir)).toBe(join(dataDir, "copilot-cli"));
  });

  it("refuses path-shaped versions for cache directories", () => {
    expect(() => getPinnedCopilotCliDir("cache", "../escape")).toThrow(/Invalid Copilot CLI version/);
  });
});

describe("copilot-cli launch resolution", () => {
  it("refuses to launch when the pinned build is not cached", () => {
    const root = makeTestDir("cli-launch-missing");
    writeLock(root, releaseLock("a".repeat(64)));
    expect(() => resolveCopilotCliForLaunch({ rootDir: root, cacheDir: join(root, "cache"), platformKey: PLATFORM }))
      .toThrow(/not ready/);
  });

  it("refuses to launch when the lock has no asset for this platform or is invalid", () => {
    const root = makeTestDir("cli-launch-platform");
    writeLock(root, releaseLock("a".repeat(64)));
    expect(() => resolveCopilotCliForLaunch({ rootDir: root, cacheDir: join(root, "cache"), platformKey: "linux-x64" }))
      .toThrow(/no asset for linux-x64/);
    writeFileSync(join(root, COPILOT_CLI_LOCK_FILENAME), "{broken");
    expect(() => resolveCopilotCliForLaunch({ rootDir: root, cacheDir: join(root, "cache"), platformKey: PLATFORM }))
      .toThrow(/not valid JSON/);
  });

  it("requires the marker, entry points, and a matching package version before launching pinned", () => {
    const root = makeTestDir("cli-launch-ready");
    const cacheDir = join(root, "cache");
    const appDir = getPinnedCopilotCliDir(cacheDir, VERSION);
    writeLock(root, releaseLock("a".repeat(64)));
    mkdirSync(appDir, { recursive: true });
    expect(checkPinnedCopilotCliDir(appDir, VERSION)).toMatchObject({ ready: false, reason: expect.stringContaining("marker") });

    writeFileSync(join(appDir, PINNED_COPILOT_CLI_MARKER), JSON.stringify({
      version: VERSION, asset: ASSET_NAME, sha256: "a".repeat(64), installedAt: new Date().toISOString(),
    }));
    expect(checkPinnedCopilotCliDir(appDir, VERSION)).toMatchObject({ ready: false, reason: "app.js missing" });

    writeFileSync(join(appDir, "app.js"), "");
    writeFileSync(join(appDir, "index.js"), "");
    writeFileSync(join(appDir, "package.json"), JSON.stringify({ version: "1.0.80" }));
    expect(checkPinnedCopilotCliDir(appDir, VERSION)).toMatchObject({ ready: false, reason: expect.stringContaining("package.json version 1.0.80") });

    writeFileSync(join(appDir, "package.json"), JSON.stringify({ version: VERSION }));
    expect(checkPinnedCopilotCliDir(appDir, VERSION)).toEqual({ ready: true });
    const resolution = resolveCopilotCliForLaunch({ rootDir: root, cacheDir, platformKey: PLATFORM });
    expect(resolution).toEqual({ version: VERSION, appDir });
    expect(describeCopilotCliResolution(resolution)).toBe(`pinned ${VERSION} (${appDir})`);
  });
});

describe("ensurePinnedCopilotCli", () => {
  it("downloads, verifies, extracts, marks, and then reuses the pinned build", async () => {
    const root = makeTestDir("cli-ensure-ok");
    const fixture = makeTestDir("cli-ensure-ok-fixture");
    const tarball = buildReleaseTarball(fixture);
    const cacheDir = join(root, "cache");
    writeLock(root, releaseLock(sha256(tarball)));
    const calls: string[] = [];
    const logs: string[] = [];
    const now = new Date("2026-08-21T17:00:00.000Z");

    const first = await ensurePinnedCopilotCli({
      rootDir: root,
      cacheDir,
      platformKey: PLATFORM,
      downloader: downloaderFor(getCopilotCliReleaseAssetUrl(VERSION, ASSET_NAME), tarball, calls),
      log: (message) => logs.push(message),
      now: () => now,
    });

    const appDir = getPinnedCopilotCliDir(cacheDir, VERSION);
    expect(first).toEqual({ version: VERSION, appDir });
    expect(calls).toHaveLength(1);
    expect(existsSync(join(appDir, "app.js"))).toBe(true);
    expect(existsSync(join(appDir, "prebuilds", PLATFORM, "runtime.node"))).toBe(true);
    expect(readPinnedCopilotCliMarker(appDir)).toEqual({
      version: VERSION,
      asset: ASSET_NAME,
      sha256: sha256(tarball),
      installedAt: now.toISOString(),
    });
    // Work directory is cleaned up after the rename.
    expect(existsSync(join(cacheDir, "extract"))).toBe(false);
    expect(logs.some((line) => /Downloading pinned Copilot CLI/.test(line))).toBe(true);

    const second = await ensurePinnedCopilotCli({
      rootDir: root,
      cacheDir,
      platformKey: PLATFORM,
      downloader: downloaderFor("never", tarball, calls),
    });
    expect(second).toEqual(first);
    expect(calls).toHaveLength(1);
  });

  it("rejects a tarball whose sha256 does not match", async () => {
    const root = makeTestDir("cli-ensure-sha");
    const fixture = makeTestDir("cli-ensure-sha-fixture");
    const tarball = buildReleaseTarball(fixture);
    const cacheDir = join(root, "cache");
    writeLock(root, releaseLock("b".repeat(64)));

    await expect(ensurePinnedCopilotCli({
      rootDir: root,
      cacheDir,
      platformKey: PLATFORM,
      downloader: downloaderFor(getCopilotCliReleaseAssetUrl(VERSION, ASSET_NAME), tarball),
    })).rejects.toThrow(/sha256 mismatch/);
    expect(existsSync(getPinnedCopilotCliDir(cacheDir, VERSION))).toBe(false);
  });

  it("rejects an extracted package whose version or entry points do not match the lock", async () => {
    const root = makeTestDir("cli-ensure-shape");
    const cacheDir = join(root, "cache");
    const wrongVersion = buildReleaseTarball(makeTestDir("cli-ensure-shape-v"), { version: "1.0.80" });
    writeLock(root, releaseLock(sha256(wrongVersion)));
    await expect(ensurePinnedCopilotCli({
      rootDir: root, cacheDir, platformKey: PLATFORM,
      downloader: downloaderFor(getCopilotCliReleaseAssetUrl(VERSION, ASSET_NAME), wrongVersion),
    })).rejects.toThrow(/package\.json version 1\.0\.80/);

    const noIndex = buildReleaseTarball(makeTestDir("cli-ensure-shape-i"), { omit: ["index.js"] });
    writeLock(root, releaseLock(sha256(noIndex)));
    await expect(ensurePinnedCopilotCli({
      rootDir: root, cacheDir, platformKey: PLATFORM,
      downloader: downloaderFor(getCopilotCliReleaseAssetUrl(VERSION, ASSET_NAME), noIndex),
    })).rejects.toThrow(/missing index\.js/);
    expect(existsSync(getPinnedCopilotCliDir(cacheDir, VERSION))).toBe(false);
  });

  it("surfaces download failures without leaving partial installs", async () => {
    const root = makeTestDir("cli-ensure-download");
    const cacheDir = join(root, "cache");
    writeLock(root, releaseLock("c".repeat(64)));
    await expect(ensurePinnedCopilotCli({
      rootDir: root, cacheDir, platformKey: PLATFORM,
      downloader: async () => { throw new Error("download failed: HTTP 404 Not Found"); },
    })).rejects.toThrow(/HTTP 404/);
    expect(existsSync(getPinnedCopilotCliDir(cacheDir, VERSION))).toBe(false);
  });

  it("is a no-op for an already-ready cache", async () => {
    const root = makeTestDir("cli-ensure-noop");
    const cacheDir = join(root, "cache");
    const appDir = getPinnedCopilotCliDir(cacheDir, VERSION);
    writeLock(root, releaseLock("a".repeat(64)));
    mkdirSync(appDir, { recursive: true });
    for (const file of ["app.js", "index.js"]) writeFileSync(join(appDir, file), "");
    writeFileSync(join(appDir, "package.json"), JSON.stringify({ version: VERSION }));
    writeFileSync(join(appDir, PINNED_COPILOT_CLI_MARKER), JSON.stringify({
      version: VERSION, asset: ASSET_NAME, sha256: "a".repeat(64), installedAt: new Date().toISOString(),
    }));
    const result = await ensurePinnedCopilotCli({
      rootDir: root, cacheDir, platformKey: PLATFORM,
      downloader: async () => { throw new Error("must not download"); },
    });
    expect(result).toEqual({ version: VERSION, appDir });
  });

  it("coalesces concurrent ensures in one process", async () => {
    const root = makeTestDir("cli-ensure-concurrent");
    const tarball = buildReleaseTarball(makeTestDir("cli-ensure-concurrent-fixture"));
    const cacheDir = join(root, "cache");
    writeLock(root, releaseLock(sha256(tarball)));
    const calls: string[] = [];
    const options = {
      rootDir: root, cacheDir, platformKey: PLATFORM,
      downloader: downloaderFor(getCopilotCliReleaseAssetUrl(VERSION, ASSET_NAME), tarball, calls),
    };
    const [a, b] = await Promise.all([ensurePinnedCopilotCli(options), ensurePinnedCopilotCli(options)]);
    expect(a).toEqual(b);
    expect(a.version).toBe(VERSION);
    expect(calls).toHaveLength(1);
  });

  it("tolerates another process installing the same version first", async () => {
    const root = makeTestDir("cli-ensure-race");
    const tarball = buildReleaseTarball(makeTestDir("cli-ensure-race-fixture"));
    const cacheDir = join(root, "cache");
    writeLock(root, releaseLock(sha256(tarball)));
    const appDir = getPinnedCopilotCliDir(cacheDir, VERSION);
    const result = await ensurePinnedCopilotCli({
      rootDir: root, cacheDir, platformKey: PLATFORM,
      downloader: downloaderFor(getCopilotCliReleaseAssetUrl(VERSION, ASSET_NAME), tarball),
      // Simulate the other process finishing between our download and our rename.
      extractor: async (tarballPath, targetDir) => {
        execFileSync("tar", ["-xzf", tarballPath, "-C", targetDir], { stdio: "pipe" });
        mkdirSync(appDir, { recursive: true });
        for (const file of ["app.js", "index.js"]) writeFileSync(join(appDir, file), "");
        writeFileSync(join(appDir, "package.json"), JSON.stringify({ version: VERSION }));
        writeFileSync(join(appDir, PINNED_COPILOT_CLI_MARKER), JSON.stringify({
          version: VERSION, asset: ASSET_NAME, sha256: sha256(tarball), installedAt: new Date().toISOString(),
        }));
      },
    });
    expect(result).toEqual({ version: VERSION, appDir });
  });
});

describe("prunePinnedCopilotCliCache", () => {
  it("removes stale work dirs and unreferenced old versions only", () => {
    const cacheDir = makeTestDir("cli-prune");
    const now = Date.parse("2026-08-21T18:00:00.000Z");
    const keep = join(cacheDir, VERSION);
    const old = join(cacheDir, "1.0.80-1");
    const fresh = join(cacheDir, "1.0.82-0");
    const staleWork = join(cacheDir, ".work-1.0.81-6-123-1");
    const liveWork = join(cacheDir, ".work-1.0.81-6-124-2");
    for (const dir of [keep, old, fresh, staleWork, liveWork]) mkdirSync(dir, { recursive: true });
    const marker = (version: string, installedAt: string) => JSON.stringify({ version, asset: "x.tgz", sha256: "a".repeat(64), installedAt });
    writeFileSync(join(keep, PINNED_COPILOT_CLI_MARKER), marker(VERSION, "2026-08-01T00:00:00.000Z"));
    writeFileSync(join(old, PINNED_COPILOT_CLI_MARKER), marker("1.0.80-1", "2026-07-01T00:00:00.000Z"));
    writeFileSync(join(fresh, PINNED_COPILOT_CLI_MARKER), marker("1.0.82-0", "2026-08-21T12:00:00.000Z"));
    const staleTime = new Date(now - 2 * 60 * 60_000);
    utimesSync(staleWork, staleTime, staleTime);
    const liveTime = new Date(now - 60_000);
    utimesSync(liveWork, liveTime, liveTime);

    const removed = prunePinnedCopilotCliCache(cacheDir, {
      keepVersions: [VERSION],
      minAgeMs: 7 * 24 * 60 * 60_000,
      now: () => now,
    });

    expect(removed.sort()).toEqual([old, staleWork].sort());
    expect(existsSync(keep)).toBe(true);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(liveWork)).toBe(true);
  });
});
