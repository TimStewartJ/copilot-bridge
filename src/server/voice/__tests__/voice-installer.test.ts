import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { makeTestDir } from "../../__tests__/helpers.js";
import { preferHighPerformanceScheduling, resolveTarCommand } from "../../platform.js";
import { isVoiceTargetSupported, resolveVoicePaths, selectVoiceEnginePackages, VOICE_ENGINE_PACKAGES, VOICE_MODELS } from "../voice-catalog.js";
import { VoiceInstaller, type ExtractArchive } from "../voice-installer.js";

function fakeResponse(body: Buffer) {
  return new Response(new Uint8Array(body), { status: 200, headers: { "content-length": String(body.length) } });
}

describe("voice catalog", () => {
  it("selects the native packages for the host target", () => {
    const names = selectVoiceEnginePackages("win32-x64").map((asset) => asset.name);
    expect(names).toContain("sherpa-onnx-win-x64");
    expect(names).not.toContain("sherpa-onnx-linux-x64");
    expect(names).toContain("onnxruntime-node");
    expect(VOICE_ENGINE_PACKAGES.find((asset) => asset.name === "onnxruntime-node")!.members!("linux-x64"))
      .toContain("package/bin/napi-v6/linux/x64");
    expect(isVoiceTargetSupported("win32-x64")).toBe(true);
    expect(isVoiceTargetSupported("sunos-sparc")).toBe(false);
  });
});

describe("VoiceInstaller", () => {
  it("downloads, verifies and extracts every asset, then reports installed", async () => {
    const dataDir = makeTestDir("voice-install");
    const paths = resolveVoicePaths({ dataDir, env: {} });
    const bodies = new Map<string, Buffer>();
    const packageAssets = selectVoiceEnginePackages("linux-x64");
    for (const asset of packageAssets) {
      const body = Buffer.from(`tarball:${asset.name}`);
      bodies.set(asset.tarballUrl, body);
      (asset as { integrity: string }).integrity = `sha512-${createHash("sha512").update(body).digest("base64")}`;
    }
    for (const asset of VOICE_MODELS) {
      const body = Buffer.from(`model:${asset.id}`);
      bodies.set(asset.url, body);
      (asset as { sha256: string }).sha256 = createHash("sha256").update(body).digest("hex");
    }
    const fetchImpl = vi.fn(async (url: string | URL | Request) => fakeResponse(bodies.get(String(url))!));
    const extract: ExtractArchive = vi.fn(async (archivePath, destination, options) => {
      const contents = readFileSync(archivePath, "utf8");
      if (options.compression === "gzip") {
        const name = contents.replace("tarball:", "");
        const asset = packageAssets.find((candidate) => candidate.name === name)!;
        mkdirSync(join(destination, "package"), { recursive: true });
        writeFileSync(join(destination, "package", "package.json"), JSON.stringify({ name: asset.name, version: asset.version }));
      } else {
        const asset = VOICE_MODELS.find((candidate) => contents === `model:${candidate.id}`)!;
        for (const file of asset.verifyFiles) {
          mkdirSync(join(destination, file, ".."), { recursive: true });
          writeFileSync(join(destination, file), "x");
        }
      }
    });
    const installer = new VoiceInstaller({ paths, target: "linux-x64", fetch: fetchImpl as unknown as typeof fetch, extract, logger: { log() {}, warn() {}, error() {} } });
    expect(installer.getStatus()).toMatchObject({ installed: false, supported: true });
    const phases = new Set<string>();
    installer.onStatus((status) => {
      if (status.progress) phases.add(status.progress.phase);
    });
    await installer.install();
    const status = installer.getStatus();
    expect(status.installed).toBe(true);
    expect(status.remainingBytes).toBe(0);
    expect(phases.has("verifying")).toBe(true);
    expect(existsSync(join(paths.engineDir, "node_modules", "onnxruntime-node", "package.json"))).toBe(true);
    expect(existsSync(join(paths.modelsDir, "silero_vad.onnx"))).toBe(true);
    expect(existsSync(join(paths.downloadsDir, "sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8.tar.bz2"))).toBe(false);

    // A second install is a no-op.
    fetchImpl.mockClear();
    await installer.install();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects a download whose digest does not match", async () => {
    const paths = resolveVoicePaths({ dataDir: makeTestDir("voice-install-bad"), env: {} });
    const installer = new VoiceInstaller({
      paths,
      target: "linux-x64",
      fetch: (async () => fakeResponse(Buffer.from("tampered"))) as unknown as typeof fetch,
      extract: vi.fn(),
      logger: { log() {}, warn() {}, error() {} },
    });
    await expect(installer.install()).rejects.toThrow(/Integrity check failed/);
    expect(installer.getStatus()).toMatchObject({ installed: false, error: expect.stringContaining("Integrity check failed") });
  });
});

describe("platform helpers for voice", () => {
  it("prefers the Windows system bsdtar and plain tar elsewhere", () => {
    expect(resolveTarCommand({ platform: "linux" })).toBe("tar");
    expect(resolveTarCommand({ platform: "win32", env: { SystemRoot: "C:\\Windows" }, exists: () => true }))
      .toBe("C:\\Windows\\System32\\tar.exe");
    expect(resolveTarCommand({ platform: "win32", env: {}, exists: () => false })).toBe("tar");
  });

  it("opts out of EcoQoS only on Windows", async () => {
    const api = {
      getCurrentProcess: vi.fn(() => "handle"),
      setProcessPowerThrottling: vi.fn(() => 1),
      setPriorityClass: vi.fn(() => 1),
    };
    await expect(preferHighPerformanceScheduling({ platform: "linux", loadApi: async () => api })).resolves.toEqual({ applied: false, detail: "not windows" });
    expect(api.getCurrentProcess).not.toHaveBeenCalled();
    const result = await preferHighPerformanceScheduling({ platform: "win32", loadApi: async () => api });
    expect(result.applied).toBe(true);
    expect(api.setProcessPowerThrottling).toHaveBeenCalledWith("handle", { Version: 1, ControlMask: 1, StateMask: 0 });
    const failing = await preferHighPerformanceScheduling({ platform: "win32", loadApi: async () => { throw new Error("no koffi"); } });
    expect(failing).toEqual({ applied: false, detail: "no koffi" });
  });
});
