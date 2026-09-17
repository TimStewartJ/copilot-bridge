import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { makeTestDir } from "../../__tests__/helpers.js";
import { testPosixPath, testWindowsPath } from "../../__tests__/test-paths.js";
import { moveFreshPath, preferHighPerformanceScheduling, resolveNpmInvocation, resolveTarCommand } from "../../platform.js";
import { isVoiceTargetSupported, resolveVoicePaths, selectVoiceEnginePackages, VOICE_ENGINE_PACKAGES, VOICE_MODELS, type VoiceAsset } from "../voice-catalog.js";
import { VoiceInstaller, type ExtractArchive, type VoiceInstallerOptions } from "../voice-installer.js";
import { CommandError, type NpmClient } from "../voice-npm-client.js";

const TARGET = "linux-x64";

function fakeResponse(body: Buffer) {
  return new Response(new Uint8Array(body), { status: 200, headers: { "content-length": String(body.length) } });
}

function archiveName(asset: VoiceAsset): string {
  return asset.kind === "npm" ? `${asset.name}-${asset.version}.tgz` : asset.fileName ?? asset.url.split("/").at(-1)!;
}

/** Re-pins the catalog to small fake archives so a whole install runs without the network or npm. */
function pinFakeAssets() {
  const packages = selectVoiceEnginePackages(TARGET);
  const byUrl = new Map<string, Buffer>();
  const byFileName = new Map<string, Buffer>();
  for (const asset of packages) {
    const body = Buffer.from(`tarball:${asset.name}`);
    byFileName.set(archiveName(asset), body);
    (asset as { integrity: string }).integrity = `sha512-${createHash("sha512").update(body).digest("base64")}`;
  }
  for (const asset of VOICE_MODELS) {
    const body = Buffer.from(`model:${asset.id}`);
    byUrl.set(asset.url, body);
    byFileName.set(archiveName(asset), body);
    (asset as { sha256: string }).sha256 = createHash("sha256").update(body).digest("hex");
  }
  const extract: ExtractArchive = vi.fn(async (archivePath, destination, options) => {
    const contents = readFileSync(archivePath, "utf8");
    if (options.compression === "gzip") {
      const asset = packages.find((candidate) => contents === `tarball:${candidate.name}`)!;
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
  const fetchImpl = vi.fn(async (url: string | URL | Request) => fakeResponse(byUrl.get(String(url))!));
  return { packages, byFileName, extract, fetchImpl };
}

function fakeNpmClient(byFileName: Map<string, Buffer>) {
  return {
    pack: vi.fn<NpmClient["pack"]>(async (spec, directory) => {
      const [name, version] = spec.split("@");
      const fileName = `${name}-${version}.tgz`;
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, fileName), byFileName.get(fileName)!);
      return join(directory, fileName);
    }),
  };
}

const unreachable = (async () => {
  throw new TypeError("fetch failed", { cause: Object.assign(new Error("getaddrinfo ENOTFOUND github.com"), { code: "ENOTFOUND" }) });
}) as unknown as typeof fetch;

/**
 * Builds an installer that never sleeps between move retries. With `only`, every other asset is
 * marked as installed so a scenario touches the file system for just the asset it is about: the
 * suite runs under heavy load, where hundreds of real file operations per test invite timeouts.
 */
function createInstaller(prefix: string, options: Pick<VoiceInstallerOptions, "npmClient"> & Partial<VoiceInstallerOptions> & { only?: string[] }) {
  const { only, ...installerOptions } = options;
  const paths = resolveVoicePaths({ dataDir: makeTestDir(prefix), env: {} });
  if (only) {
    mkdirSync(join(paths.voiceDir, "installed"), { recursive: true });
    for (const asset of [...selectVoiceEnginePackages(TARGET), ...VOICE_MODELS].filter((candidate) => !only.includes(candidate.id))) {
      writeFileSync(join(paths.voiceDir, "installed", `${asset.id}.json`), "{}");
      const files = asset.kind === "npm"
        ? [join(paths.engineDir, "node_modules", asset.name, "package.json")]
        : asset.verifyFiles.map((file) => join(paths.modelsDir, file));
      for (const file of files) {
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, "x");
      }
    }
  }
  const installer = new VoiceInstaller({
    paths,
    target: TARGET,
    env: {},
    wait: async () => undefined,
    logger: { log() {}, warn() {}, error() {} },
    ...installerOptions,
  });
  return { paths, installer };
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
  it("gets packages from npm and models over HTTPS, verifies and extracts them, then reports installed", async () => {
    const { packages, byFileName, extract, fetchImpl } = pinFakeAssets();
    const npmClient = fakeNpmClient(byFileName);
    const { paths, installer } = createInstaller("voice-install", { fetch: fetchImpl as unknown as typeof fetch, extract, npmClient });
    expect(installer.getStatus()).toMatchObject({ installed: false, supported: true });
    const phases = new Set<string>();
    installer.onStatus((status) => {
      if (status.progress) phases.add(status.progress.phase);
    });
    await installer.install();
    const status = installer.getStatus();
    expect(status.installed).toBe(true);
    expect(status.remainingBytes).toBe(0);
    expect([...phases].sort()).toEqual(["downloading", "extracting", "verifying"]);
    expect(npmClient.pack.mock.calls.map(([spec]) => spec)).toEqual(packages.map((asset) => `${asset.name}@${asset.version}`));
    expect(fetchImpl.mock.calls.map(([url]) => String(url))).toEqual(VOICE_MODELS.map((asset) => asset.url));
    expect(existsSync(join(paths.engineDir, "node_modules", "onnxruntime-node", "package.json"))).toBe(true);
    expect(existsSync(join(paths.modelsDir, "silero_vad.onnx"))).toBe(true);
    expect(readdirSync(paths.downloadsDir)).toEqual([]);

    // A second install is a no-op.
    fetchImpl.mockClear();
    npmClient.pack.mockClear();
    await installer.install();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(npmClient.pack).not.toHaveBeenCalled();
  });

  it("rejects an npm tarball that does not match the pinned integrity", async () => {
    const { byFileName, extract, fetchImpl } = pinFakeAssets();
    const tampered = new Map([...byFileName.keys()].map((fileName) => [fileName, Buffer.from("tampered")]));
    const { paths, installer } = createInstaller("voice-install-bad-package", {
      only: ["sherpa-onnx-node"],
      fetch: fetchImpl as unknown as typeof fetch,
      extract,
      npmClient: fakeNpmClient(tampered),
    });
    await expect(installer.install()).rejects.toThrow("Integrity check failed for sherpa-onnx-node 1.13.8");
    expect(installer.getStatus()).toMatchObject({ installed: false, error: expect.stringContaining("Integrity check failed") });
    expect(extract).not.toHaveBeenCalled();
    expect(readdirSync(paths.downloadsDir)).toEqual([]);
  });

  it("rejects a model download whose digest does not match", async () => {
    const { byFileName, extract } = pinFakeAssets();
    const { installer } = createInstaller("voice-install-bad-model", {
      only: ["silero-vad"],
      fetch: (async () => fakeResponse(Buffer.from("tampered"))) as unknown as typeof fetch,
      extract,
      npmClient: fakeNpmClient(byFileName),
    });
    await expect(installer.install()).rejects.toThrow("Integrity check failed for Silero voice activity detector");
  });

  it("explains an npm failure and how to add the package by hand", async () => {
    const { extract, fetchImpl } = pinFakeAssets();
    const npmClient: NpmClient = {
      pack: async () => {
        throw new CommandError("Command failed", {
          exitCode: 1,
          missing: false,
          timedOut: false,
          stderr: "npm error code E401\nnpm error Unable to authenticate, your authentication token seems to be invalid.",
        });
      },
    };
    const { paths, installer } = createInstaller("voice-install-npm-fails", {
      only: ["sherpa-onnx-node"],
      fetch: fetchImpl as unknown as typeof fetch,
      extract,
      npmClient,
    });
    await expect(installer.install()).rejects.toThrow(/Couldn't download sherpa-onnx-node 1\.13\.8 with npm: E401: Unable to authenticate/);
    const error = installer.getStatus().error!;
    expect(error).toContain('run "npm pack sherpa-onnx-node@1.13.8" on any computer');
    expect(error).toContain(`copy sherpa-onnx-node-1.13.8.tgz into ${paths.downloadsDir}`);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("names the host and the real reason when a model cannot be downloaded", async () => {
    const { byFileName, extract } = pinFakeAssets();
    const silero = VOICE_MODELS.find((asset) => asset.id === "silero-vad")!;
    const blocked = createInstaller("voice-install-blocked", { only: ["silero-vad"], fetch: unreachable, extract, npmClient: fakeNpmClient(byFileName) });
    await expect(blocked.installer.install()).rejects.toThrow("Couldn't download Silero voice activity detector from github.com: ENOTFOUND.");
    expect(blocked.installer.getStatus().error).toContain(`download ${silero.url} on any computer, copy silero_vad.onnx into ${blocked.paths.downloadsDir}`);

    const missing = createInstaller("voice-install-404", {
      only: ["silero-vad"],
      fetch: (async () => new Response("missing", { status: 404 })) as unknown as typeof fetch,
      extract,
      npmClient: fakeNpmClient(byFileName),
    });
    await expect(missing.installer.install()).rejects.toThrow("from github.com: HTTP 404.");
  });

  it("installs from archives copied into the downloads folder without npm or the network", async () => {
    const { byFileName, extract } = pinFakeAssets();
    const npmClient = fakeNpmClient(new Map());
    const copied = ["sherpa-onnx-node-1.13.8.tgz", "kokoro-multi-lang-v1_0.tar.bz2"];
    const { paths, installer } = createInstaller("voice-install-offline", { only: ["sherpa-onnx-node", "kokoro"], fetch: unreachable, extract, npmClient });
    mkdirSync(paths.downloadsDir, { recursive: true });
    for (const fileName of copied) writeFileSync(join(paths.downloadsDir, fileName), byFileName.get(fileName)!);
    await installer.install();
    expect(installer.getStatus().installed).toBe(true);
    expect(extract).toHaveBeenCalledTimes(copied.length);
    expect(npmClient.pack).not.toHaveBeenCalled();
    expect(readdirSync(paths.downloadsDir)).toEqual([]);
  });

  it("replaces a hand-copied archive that fails verification with a fresh download", async () => {
    const { byFileName, extract, fetchImpl } = pinFakeAssets();
    const { paths, installer } = createInstaller("voice-install-bad-copy", {
      only: ["silero-vad"],
      fetch: fetchImpl as unknown as typeof fetch,
      extract,
      npmClient: fakeNpmClient(byFileName),
    });
    mkdirSync(paths.downloadsDir, { recursive: true });
    writeFileSync(join(paths.downloadsDir, "silero_vad.onnx"), "truncated");
    await installer.install();
    expect(installer.getStatus().installed).toBe(true);
    expect(readFileSync(join(paths.modelsDir, "silero_vad.onnx"), "utf8")).toBe("model:silero-vad");
  });

  it("says that a hand-copied archive was rejected when it cannot download a replacement", async () => {
    const { byFileName, extract } = pinFakeAssets();
    const { paths, installer } = createInstaller("voice-install-bad-copy-offline", {
      only: ["silero-vad"],
      fetch: unreachable,
      extract,
      npmClient: fakeNpmClient(byFileName),
    });
    mkdirSync(paths.downloadsDir, { recursive: true });
    writeFileSync(join(paths.downloadsDir, "silero_vad.onnx"), "truncated");
    await expect(installer.install()).rejects.toThrow("The silero_vad.onnx that was already there did not match the expected digest and was removed.");
    expect(readdirSync(paths.downloadsDir)).toEqual([]);
  });

  it("keeps a verified archive when unpacking fails so a retry does not download it again", async () => {
    const { byFileName, extract, fetchImpl } = pinFakeAssets();
    const kokoro = VOICE_MODELS.find((asset) => asset.id === "kokoro")!;
    let failUnpack = true;
    const flakyExtract: ExtractArchive = async (archivePath, destination, options) => {
      if (failUnpack) throw new Error("Failed to extract: disk full");
      return extract(archivePath, destination, options);
    };
    const { paths, installer } = createInstaller("voice-install-unpack", {
      only: ["kokoro"],
      fetch: fetchImpl as unknown as typeof fetch,
      extract: flakyExtract,
      npmClient: fakeNpmClient(byFileName),
    });
    await expect(installer.install()).rejects.toThrow("disk full");
    expect(readdirSync(paths.downloadsDir)).toEqual([archiveName(kokoro)]);

    failUnpack = false;
    fetchImpl.mockClear();
    await installer.install();
    expect(installer.getStatus().installed).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(readdirSync(paths.downloadsDir)).toEqual([]);
  });
});
describe("platform helpers for voice", () => {
  it("prefers the Windows system bsdtar and plain tar elsewhere", () => {
    expect(resolveTarCommand({ platform: "linux" })).toBe("tar");
    expect(resolveTarCommand({ platform: "win32", env: { SystemRoot: "C:\\Windows" }, exists: () => true }))
      .toBe("C:\\Windows\\System32\\tar.exe");
    expect(resolveTarCommand({ platform: "win32", env: {}, exists: () => false })).toBe("tar");
  });

  it("runs the npm that ships beside Node without a shell", () => {
    const windowsNode = testWindowsPath("Program Files", "nodejs", "node.exe");
    const windowsCli = testWindowsPath("Program Files", "nodejs", "node_modules", "npm", "bin", "npm-cli.js");
    expect(resolveNpmInvocation({ platform: "win32", env: {}, execPath: windowsNode, exists: (path) => path === windowsCli }))
      .toEqual({ command: windowsNode, args: [windowsCli] });

    const posixNode = testPosixPath("opt", "node", "bin", "node");
    const posixCli = testPosixPath("opt", "node", "lib", "node_modules", "npm", "bin", "npm-cli.js");
    expect(resolveNpmInvocation({ platform: "linux", env: {}, execPath: posixNode, exists: (path) => path === posixCli }))
      .toEqual({ command: posixNode, args: [posixCli] });
  });

  it("falls back to the npm on PATH", () => {
    const windowsNode = testWindowsPath("tools", "node", "node.exe");
    const npmDir = testWindowsPath("tools", "npm");
    const windowsCli = testWindowsPath("tools", "npm", "node_modules", "npm", "bin", "npm-cli.js");
    const windowsFiles = new Set([windowsCli, testWindowsPath("tools", "npm", "npm.cmd")]);
    // A copied environment keeps Windows' original "Path" spelling.
    expect(resolveNpmInvocation({
      platform: "win32",
      env: { Path: `${testWindowsPath("empty")};${npmDir}` },
      execPath: windowsNode,
      exists: (path) => windowsFiles.has(path),
    })).toEqual({ command: windowsNode, args: [windowsCli] });
    expect(resolveNpmInvocation({ platform: "win32", env: { Path: testWindowsPath("empty") }, execPath: windowsNode, exists: () => false }))
      .toBeUndefined();
    // POSIX can execute the npm launcher directly, so the lookup is left to the OS.
    expect(resolveNpmInvocation({ platform: "linux", env: {}, execPath: testPosixPath("opt", "runtime", "node"), exists: () => false }))
      .toEqual({ command: "npm", args: [] });
  });

  it("retries a rename that a scanner is blocking, then copies instead", async () => {
    const busy = (code: string) => Object.assign(new Error(`${code}: operation not permitted`), { code });
    const wait = vi.fn(async (_delayMs: number) => undefined);
    const copyPath = vi.fn(async () => undefined);
    const removePath = vi.fn(async () => undefined);

    const renameTwice = vi.fn()
      .mockRejectedValueOnce(busy("EPERM"))
      .mockRejectedValueOnce(busy("EBUSY"))
      .mockResolvedValueOnce(undefined);
    await moveFreshPath("from", "to", { renamePath: renameTwice, copyPath, removePath, wait });
    expect(renameTwice).toHaveBeenCalledTimes(3);
    expect(wait.mock.calls.map(([delayMs]) => delayMs)).toEqual([100, 250]);
    expect(copyPath).not.toHaveBeenCalled();

    const alwaysBusy = vi.fn().mockRejectedValue(busy("EACCES"));
    const log = vi.fn();
    removePath.mockRejectedValueOnce(busy("EPERM"));
    await moveFreshPath("from", "to", { renamePath: alwaysBusy, copyPath, removePath, wait, log });
    expect(alwaysBusy).toHaveBeenCalledTimes(8);
    expect(copyPath).toHaveBeenCalledWith("from", "to");
    expect(removePath).toHaveBeenCalledWith("from");
    expect(log).toHaveBeenCalledTimes(2);

    // Another volume can never be renamed onto, so copy straight away.
    copyPath.mockClear();
    const crossDevice = vi.fn().mockRejectedValue(busy("EXDEV"));
    await moveFreshPath("from", "to", { renamePath: crossDevice, copyPath, removePath, wait });
    expect(crossDevice).toHaveBeenCalledOnce();
    expect(copyPath).toHaveBeenCalledOnce();

    await expect(moveFreshPath("from", "to", { renamePath: vi.fn().mockRejectedValue(busy("ENOENT")), copyPath, removePath, wait }))
      .rejects.toMatchObject({ code: "ENOENT" });
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
