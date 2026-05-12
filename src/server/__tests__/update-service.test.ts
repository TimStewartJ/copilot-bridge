import { generateKeyPairSync, sign } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  checkForUpdate,
  compareVersions,
  readUpdateInstallStatus,
  startUpdateInstall,
  type UpdateInstallStatus,
} from "../update-service.js";
import { makeTestDir, makeTestRuntimePaths } from "./helpers.js";

function createKeyPair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    signManifest: (manifestText: string) => sign(null, Buffer.from(manifestText, "utf8"), privateKey).toString("base64"),
  };
}

function writeReleaseAppRoot(version: string, channel = "stable", platform = "win-x64") {
  const releaseRoot = makeTestDir("update-release-root");
  const appRoot = join(releaseRoot, "app");
  mkdirSync(appRoot, { recursive: true });
  writeFileSync(join(appRoot, "package.json"), JSON.stringify({ version }));
  writeFileSync(join(appRoot, ".bridge-release.json"), JSON.stringify({
    version,
    channel,
    platform,
    sourceCommit: "current-sha",
  }));
  return appRoot;
}

function manifestText(version: string, overrides: Record<string, unknown> = {}) {
  return `${JSON.stringify({
    schemaVersion: 1,
    appId: "copilot-bridge",
    keyId: "test",
    version,
    channel: "stable",
    platform: "win-x64",
    sourceCommit: "next-sha",
    publishedAt: "2026-05-08T20:00:00.000Z",
    releaseUrl: "https://github.com/timstewartj/copilot-bridge/releases/tag/v0.2.0",
    releaseNotesUrl: "https://github.com/timstewartj/copilot-bridge/releases/tag/v0.2.0",
    package: {
      name: "copilot-bridge-0.2.0-stable-win-x64.zip",
      url: "https://github.com/timstewartj/copilot-bridge/releases/download/v0.2.0/copilot-bridge-0.2.0-stable-win-x64.zip",
      sha256: "a".repeat(64),
      sizeBytes: 1024,
    },
    ...overrides,
  }, null, 2)}\n`;
}

function fetchManifest(manifest: string, signature: string): typeof fetch {
  return (async (url: string | URL | Request) => {
    const text = String(url).endsWith(".sig") ? `${signature}\n` : manifest;
    return new Response(text, { status: 200, headers: { "content-type": "text/plain" } });
  }) as typeof fetch;
}

function writeInstallStatus(runtimePaths: ReturnType<typeof makeTestRuntimePaths>, status: UpdateInstallStatus) {
  writeFileSync(join(runtimePaths.dataDir, "update-status.json"), `${JSON.stringify(status, null, 2)}\n`);
}

describe("update service", () => {
  it("compares stable and preview versions", () => {
    expect(compareVersions("0.2.0", "0.1.9")).toBeGreaterThan(0);
    expect(compareVersions("0.2.0", "0.2.0-preview.10.1.gabcdef0")).toBeGreaterThan(0);
    expect(compareVersions("0.2.0-preview.11.1.gabcdef0", "0.2.0-preview.10.1.gabcdef0")).toBeGreaterThan(0);
    expect(compareVersions("0.2.0", "0.2.0")).toBe(0);
  });

  it("returns update_available for a valid signed newer manifest", async () => {
    const keys = createKeyPair();
    const manifest = manifestText("0.2.0");
    const runtimePaths = makeTestRuntimePaths("update-release", { distributionMode: "release" });
    const appRoot = writeReleaseAppRoot("0.1.0");
    const result = await checkForUpdate({
      appRoot,
      runtimePaths,
      env: {
        ...runtimePaths.env,
        BRIDGE_UPDATE_MANIFEST_PUBLIC_KEY_PEM: keys.publicPem,
        BRIDGE_UPDATE_MANIFEST_STABLE_URL: "https://updates.example.test/stable-win-x64.manifest.json",
      },
      fetchImpl: fetchManifest(manifest, keys.signManifest(manifest)),
      now: () => new Date("2026-05-08T20:10:00.000Z"),
    });

    expect(result.status).toBe("update_available");
    expect(result.update?.version).toBe("0.2.0");
  });

  it("defaults update checks to the installed release channel", async () => {
    const keys = createKeyPair();
    const manifest = manifestText("0.2.0-preview.1", {
      channel: "preview",
      package: {
        name: "copilot-bridge-0.2.0-preview.1-preview-win-x64.zip",
        url: "https://github.com/timstewartj/copilot-bridge/releases/download/preview-0.2.0-preview.1/copilot-bridge-0.2.0-preview.1-preview-win-x64.zip",
        sha256: "a".repeat(64),
        sizeBytes: 1024,
      },
    });
    const runtimePaths = makeTestRuntimePaths("update-release-preview-default", { distributionMode: "release" });
    const appRoot = writeReleaseAppRoot("0.1.0-preview.1", "preview");
    const result = await checkForUpdate({
      appRoot,
      runtimePaths,
      env: {
        ...runtimePaths.env,
        BRIDGE_UPDATE_MANIFEST_PUBLIC_KEY_PEM: keys.publicPem,
        BRIDGE_UPDATE_MANIFEST_PREVIEW_URL: "https://updates.example.test/preview-win-x64.manifest.json",
      },
      fetchImpl: fetchManifest(manifest, keys.signManifest(manifest)),
    });

    expect(result.channel).toBe("preview");
    expect(result.current.channel).toBe("preview");
    expect(result.status).toBe("update_available");
    expect(result.update?.channel).toBe("preview");
  });

  it("rejects a tampered manifest signature", async () => {
    const keys = createKeyPair();
    const originalManifest = manifestText("0.2.0");
    const tamperedManifest = manifestText("0.3.0");
    const runtimePaths = makeTestRuntimePaths("update-bad-signature", { distributionMode: "release" });
    const appRoot = writeReleaseAppRoot("0.1.0");
    const result = await checkForUpdate({
      appRoot,
      runtimePaths,
      env: {
        ...runtimePaths.env,
        BRIDGE_UPDATE_MANIFEST_PUBLIC_KEY_PEM: keys.publicPem,
        BRIDGE_UPDATE_MANIFEST_STABLE_URL: "https://updates.example.test/stable-win-x64.manifest.json",
      },
      fetchImpl: fetchManifest(tamperedManifest, keys.signManifest(originalManifest)),
    });

    expect(result.status).toBe("error");
    expect(result.error).toContain("signature");
  });

  it("does not offer same or older signed manifests", async () => {
    const keys = createKeyPair();
    const manifest = manifestText("0.1.0");
    const runtimePaths = makeTestRuntimePaths("update-same-version", { distributionMode: "release" });
    const appRoot = writeReleaseAppRoot("0.1.0");
    const result = await checkForUpdate({
      appRoot,
      runtimePaths,
      env: {
        ...runtimePaths.env,
        BRIDGE_UPDATE_MANIFEST_PUBLIC_KEY_PEM: keys.publicPem,
        BRIDGE_UPDATE_MANIFEST_STABLE_URL: "https://updates.example.test/stable-win-x64.manifest.json",
      },
      fetchImpl: fetchManifest(manifest, keys.signManifest(manifest)),
    });

    expect(result.status).toBe("up_to_date");
    expect(result.update).toBeUndefined();
  });

  it("returns disabled outside release mode", async () => {
    const runtimePaths = makeTestRuntimePaths("update-dev", { distributionMode: "development" });
    const result = await checkForUpdate({
      appRoot: makeTestDir("update-dev-app"),
      runtimePaths,
      env: runtimePaths.env,
    });

    expect(result.status).toBe("disabled");
    expect(result.enabled).toBe(false);
  });

  it("returns not_configured when no trusted public key is available", async () => {
    const runtimePaths = makeTestRuntimePaths("update-no-key", { distributionMode: "release" });
    const appRoot = writeReleaseAppRoot("0.1.0");
    const result = await checkForUpdate({
      appRoot,
      runtimePaths,
      env: {
        ...runtimePaths.env,
        BRIDGE_UPDATE_MANIFEST_STABLE_URL: "https://updates.example.test/stable-win-x64.manifest.json",
      },
    });

    expect(result.status).toBe("not_configured");
    expect(result.error).toContain("public key");
  });

  it("rejects non-HTTPS package URLs", async () => {
    const keys = createKeyPair();
    const manifest = manifestText("0.2.0", {
      package: {
        name: "copilot-bridge.zip",
        url: "http://updates.example.test/copilot-bridge.zip",
        sha256: "a".repeat(64),
        sizeBytes: 1024,
      },
    });
    const runtimePaths = makeTestRuntimePaths("update-http-package", { distributionMode: "release" });
    const appRoot = writeReleaseAppRoot("0.1.0");
    const result = await checkForUpdate({
      appRoot,
      runtimePaths,
      env: {
        ...runtimePaths.env,
        BRIDGE_UPDATE_MANIFEST_PUBLIC_KEY_PEM: keys.publicPem,
        BRIDGE_UPDATE_MANIFEST_STABLE_URL: "https://updates.example.test/stable-win-x64.manifest.json",
      },
      fetchImpl: fetchManifest(manifest, keys.signManifest(manifest)),
    });

    expect(result.status).toBe("error");
    expect(result.error).toContain("HTTPS");
  });

  it("starts a detached installer from a verified update manifest", async () => {
    const keys = createKeyPair();
    const manifest = manifestText("0.2.0");
    const runtimePaths = makeTestRuntimePaths("update-install", { distributionMode: "release" });
    const appRoot = writeReleaseAppRoot("0.1.0");
    writeFileSync(join(appRoot, "..", "update.ps1"), "# test updater\n");
    const spawnCalls: Array<[string, string[], any]> = [];
    const spawnImpl = vi.fn((command: string, args: string[], options: any) => {
      spawnCalls.push([command, args, options]);
      return {
        once: vi.fn(),
        unref: vi.fn(),
      } as any;
    });

    const result = await startUpdateInstall({
      appRoot,
      runtimePaths,
      env: {
        ...runtimePaths.env,
        BRIDGE_UPDATE_MANIFEST_PUBLIC_KEY_PEM: keys.publicPem,
        BRIDGE_UPDATE_MANIFEST_STABLE_URL: "https://updates.example.test/stable-win-x64.manifest.json",
      },
      fetchImpl: fetchManifest(manifest, keys.signManifest(manifest)),
      spawnImpl,
      powerShellCommand: "pwsh-test",
      now: () => new Date("2026-05-08T20:10:00.000Z"),
    });

    expect(result.status).toBe("started");
    expect(result.install.toVersion).toBe("0.2.0");
    expect(spawnCalls).toHaveLength(1);
    const call = spawnCalls[0];
    if (!call) throw new Error("Expected updater spawn call.");
    const [command, args, options] = call;
    expect(command).toBe("pwsh-test");
    expect(args).toContain("-File");
    const launcherPath = args[args.indexOf("-File") + 1];
    if (!launcherPath) throw new Error("Expected launcher script path.");
    expect(launcherPath).toContain("update-launcher-");
    const launcherScript = readFileSync(launcherPath, "utf8");
    expect(launcherScript).toContain("Start-Process");
    expect(launcherScript).toContain("-DownloadUrl");
    expect(launcherScript).toContain("https://github.com/timstewartj/copilot-bridge/releases/download/v0.2.0/copilot-bridge-0.2.0-stable-win-x64.zip");
    expect(launcherScript).toContain("-ExpectedSha256");
    expect(launcherScript).toContain("*>>");
    expect(options.detached).toBeUndefined();
    expect(readUpdateInstallStatus({ runtimePaths }).status?.phase).toBe("started");
  });

  it("returns a sanitized and bounded update log tail", () => {
    const runtimePaths = makeTestRuntimePaths("update-log-tail", { distributionMode: "release" });
    const id = "log-tail-test";
    const logDir = join(runtimePaths.dataDir, "logs");
    const logPath = join(logDir, `update-${id}.log`);
    mkdirSync(logDir, { recursive: true });
    writeFileSync(
      logPath,
      Array.from({ length: 45 }, (_, index) => {
        const suffix = index === 44 ? "x".repeat(700) : "";
        return `line-${index + 1} \u001b[31mred\u001b[0m ${suffix}\u0001`;
      }).join("\n"),
    );
    writeInstallStatus(runtimePaths, {
      id,
      phase: "installing",
      channel: "preview",
      fromVersion: "0.1.0-preview.1",
      toVersion: "0.1.0-preview.2",
      packageUrl: "https://github.com/timstewartj/copilot-bridge/releases/download/preview/test.zip",
      packageSha256: "a".repeat(64),
      startedAt: "2026-05-08T20:00:00.000Z",
      updatedAt: "2026-05-08T20:01:00.000Z",
      logPath,
    });

    const result = readUpdateInstallStatus({ runtimePaths });

    expect(result.status?.phase).toBe("installing");
    expect(result.logTail).toHaveLength(40);
    expect(result.logTail?.[0]).toContain("line-6");
    expect(result.logTail?.some((line) => line.includes("\u001b") || line.includes("\u0001"))).toBe(false);
    expect(result.logTail?.at(-1)?.length).toBeLessThanOrEqual(503);
  });

  it("does not expose update log paths outside the update logs directory", () => {
    const runtimePaths = makeTestRuntimePaths("update-log-outside", { distributionMode: "release" });
    const logDir = join(runtimePaths.dataDir, "logs");
    const outsideDir = makeTestDir("update-log-outside-target");
    const outsideLogPath = join(outsideDir, "update-evil.log");
    mkdirSync(logDir, { recursive: true });
    writeFileSync(outsideLogPath, "secret line\n");
    writeInstallStatus(runtimePaths, {
      id: "outside",
      phase: "installing",
      channel: "preview",
      fromVersion: "0.1.0-preview.1",
      toVersion: "0.1.0-preview.2",
      packageUrl: "https://github.com/timstewartj/copilot-bridge/releases/download/preview/test.zip",
      packageSha256: "a".repeat(64),
      startedAt: "2026-05-08T20:00:00.000Z",
      updatedAt: "2026-05-08T20:01:00.000Z",
      logPath: outsideLogPath,
    });

    const result = readUpdateInstallStatus({ runtimePaths });

    expect(result.status?.phase).toBe("installing");
    expect(result.logTail).toBeUndefined();
  });

  it("treats a partial update status write as no readable status", () => {
    const runtimePaths = makeTestRuntimePaths("update-partial-status", { distributionMode: "release" });
    writeFileSync(join(runtimePaths.dataDir, "update-status.json"), "{");

    expect(readUpdateInstallStatus({ runtimePaths })).toEqual({ status: null });
  });
});
