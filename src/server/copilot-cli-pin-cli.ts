// CLI for the Bridge-pinned Copilot CLI channel (see copilot-cli-pin.ts).
//
//   npm run copilot-cli:pin -- 1.0.81-6     write copilot-cli.lock.json for a GitHub release
//   npm run copilot-cli:pin -- npm          point the lock back at the npm package
//   npm run copilot-cli:ensure              download/verify/extract the pinned build now
//   npm run copilot-cli:status              show what the next launch would use
//   npm run copilot-cli:prune               drop cached builds not referenced by the lock

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  COPILOT_CLI_CODE_ROOT,
  COPILOT_CLI_LOCK_FILENAME,
  COPILOT_CLI_PLATFORM_KEYS,
  COPILOT_CLI_RELEASE_REPO,
  describeCopilotCliResolution,
  ensurePinnedCopilotCli,
  getCopilotCliReleaseAssetUrl,
  prunePinnedCopilotCliCache,
  readCopilotCliLock,
  resolveCopilotCliForLaunch,
  type CopilotCliLock,
  type CopilotCliPlatformKey,
} from "./copilot-cli-pin.js";
import { resolveRuntimePaths } from "./runtime-paths.js";

function usage(): never {
  console.error("Usage: copilot-cli-pin <pin <version>|npm> | ensure | status | prune [--keep-days N]");
  process.exit(2);
}

function lockPath(): string {
  return join(COPILOT_CLI_CODE_ROOT, COPILOT_CLI_LOCK_FILENAME);
}

function writeLock(lock: CopilotCliLock & { reason?: string }): void {
  writeFileSync(lockPath(), `${JSON.stringify(lock, null, 2)}\n`);
  console.log(`Wrote ${lockPath()}`);
}

async function fetchReleaseChecksums(version: string): Promise<Map<string, string>> {
  const url = getCopilotCliReleaseAssetUrl(version, "SHA256SUMS.txt");
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) {
    throw new Error(`Could not fetch ${url}: HTTP ${response.status} ${response.statusText}`);
  }
  const checksums = new Map<string, string>();
  for (const line of (await response.text()).split(/\r?\n/)) {
    const match = /^([0-9a-f]{64})\s+\*?(\S+)$/.exec(line.trim());
    if (match) checksums.set(match[2], match[1]);
  }
  if (checksums.size === 0) throw new Error(`No checksums found in ${url}`);
  return checksums;
}

async function pin(version: string, reason?: string): Promise<void> {
  if (version === "npm") {
    writeLock({ source: "npm" });
    return;
  }
  const normalized = version.replace(/^v/, "");
  const checksums = await fetchReleaseChecksums(normalized);
  const assets: Partial<Record<CopilotCliPlatformKey, { name: string; sha256: string }>> = {};
  for (const key of COPILOT_CLI_PLATFORM_KEYS) {
    const name = `github-copilot-${normalized}-${key}.tgz`;
    const sha256 = checksums.get(name);
    if (!sha256) {
      console.warn(`No checksum for ${name} in the ${COPILOT_CLI_RELEASE_REPO} v${normalized} release; skipping ${key}`);
      continue;
    }
    assets[key] = { name, sha256 };
  }
  if (Object.keys(assets).length === 0) {
    throw new Error(`Release v${normalized} publishes no github-copilot-*.tgz assets`);
  }
  writeLock({
    source: "github-release",
    version: normalized,
    ...(reason ? { reason } : {}),
    assets,
  });
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const runtimePaths = resolveRuntimePaths(process.env);
  const cacheDir = runtimePaths.copilotCliCacheDir ?? join(runtimePaths.dataDir, "copilot-cli");
  switch (command) {
    case "pin": {
      const version = rest[0];
      if (!version) usage();
      const reasonIndex = rest.indexOf("--reason");
      await pin(version, reasonIndex >= 0 ? rest[reasonIndex + 1] : undefined);
      return;
    }
    case "ensure": {
      const result = await ensurePinnedCopilotCli({ cacheDir, log: (message) => console.log(message) });
      console.log(`Launch target: ${describeCopilotCliResolution(result)}`);
      if (result.source === "npm-fallback") process.exitCode = 1;
      return;
    }
    case "status": {
      const lock = readCopilotCliLock();
      console.log(`Lock: ${lock.source === "npm" ? "npm package" : `github-release ${lock.version}`}`);
      console.log(`Cache: ${cacheDir}`);
      console.log(`Launch target: ${describeCopilotCliResolution(resolveCopilotCliForLaunch({ cacheDir }))}`);
      return;
    }
    case "prune": {
      const keepDaysIndex = rest.indexOf("--keep-days");
      const keepDays = keepDaysIndex >= 0 ? Number(rest[keepDaysIndex + 1]) : 0;
      if (!Number.isFinite(keepDays) || keepDays < 0) usage();
      const lock = readCopilotCliLock();
      const removed = prunePinnedCopilotCliCache(cacheDir, {
        keepVersions: lock.source === "github-release" ? [lock.version] : [],
        minAgeMs: keepDays * 24 * 60 * 60_000,
      });
      console.log(removed.length > 0 ? `Removed:\n${removed.join("\n")}` : "Nothing to prune");
      return;
    }
    default:
      usage();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
