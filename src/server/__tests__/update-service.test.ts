import { generateKeyPairSync, sign } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { checkForUpdate, compareVersions, readUpdateInstallStatus, startUpdateInstall } from "../update-service.js";
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
    expect(args).toContain("-DownloadUrl");
    expect(args).toContain("https://github.com/timstewartj/copilot-bridge/releases/download/v0.2.0/copilot-bridge-0.2.0-stable-win-x64.zip");
    expect(args).toContain("-ExpectedSha256");
    expect(options.detached).toBe(true);
    expect(readUpdateInstallStatus({ runtimePaths }).status?.phase).toBe("started");
  });
});
