// Installs the voice engine on demand: pinned native npm packages and speech models,
// verified against published digests, into the voice data directory.
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { resolveTarCommand } from "../platform.js";
import {
  currentVoiceTarget,
  isVoiceTargetSupported,
  selectVoiceEnginePackages,
  VOICE_ENGINE_LAYOUT_VERSION,
  VOICE_MODELS,
  type VoiceAsset,
  type VoiceModelAsset,
  type VoiceNpmPackageAsset,
  type VoicePaths,
} from "./voice-catalog.js";

export interface VoiceInstallProgress {
  assetId: string;
  label: string;
  phase: "downloading" | "verifying" | "extracting";
  receivedBytes: number;
  totalBytes: number;
  overallFraction: number;
}

export interface VoiceInstallAssetStatus {
  id: string;
  label: string;
  kind: VoiceAsset["kind"];
  sizeBytes: number;
  installed: boolean;
}

export interface VoiceInstallStatus {
  supported: boolean;
  target: string;
  installed: boolean;
  installing: boolean;
  progress?: VoiceInstallProgress;
  error?: string;
  totalBytes: number;
  remainingBytes: number;
  assets: VoiceInstallAssetStatus[];
}

export type ExtractArchive = (archivePath: string, destination: string, options: {
  compression: "gzip" | "bzip2";
  members?: string[];
}) => Promise<void>;

export function createTarExtractor(tarCommand = resolveTarCommand()): ExtractArchive {
  return (archivePath, destination, options) => new Promise((resolve, reject) => {
    // Run inside the destination with a relative archive path so no drive letter reaches tar.
    const args = [
      options.compression === "gzip" ? "-xzf" : "-xjf",
      relative(destination, archivePath),
      ...(options.members ?? []),
    ];
    execFile(tarCommand, args, { cwd: destination, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (error, _stdout, stderr) => {
      if (error) {
        reject(new Error(`Failed to extract ${basename(archivePath)}: ${String(stderr || error.message).trim()}`));
        return;
      }
      resolve();
    });
  });
}

interface AssetMarker {
  id: string;
  digest: string;
  layout: number;
  installedAt: string;
}

export interface VoiceInstallerOptions {
  paths: VoicePaths;
  target?: string;
  fetch?: typeof fetch;
  extract?: ExtractArchive;
  logger?: Pick<Console, "log" | "warn" | "error">;
}

function assetLabel(asset: VoiceAsset): string {
  return asset.kind === "model" ? asset.label : `${asset.name} ${asset.version}`;
}

function assetDigest(asset: VoiceAsset): string {
  return asset.kind === "model" ? `sha256:${asset.sha256}` : asset.integrity;
}

export class VoiceInstaller {
  private installPromise?: Promise<void>;
  private progress?: VoiceInstallProgress;
  private lastError?: string;
  private readonly listeners = new Set<(status: VoiceInstallStatus) => void>();
  private readonly target: string;
  private readonly fetchImpl: typeof fetch;
  private readonly extract: ExtractArchive;
  private readonly logger: Pick<Console, "log" | "warn" | "error">;

  constructor(private readonly options: VoiceInstallerOptions) {
    this.target = options.target ?? currentVoiceTarget();
    this.fetchImpl = options.fetch ?? fetch;
    this.extract = options.extract ?? createTarExtractor();
    this.logger = options.logger ?? console;
  }

  private assets(): VoiceAsset[] {
    return [...selectVoiceEnginePackages(this.target), ...VOICE_MODELS];
  }

  private markerPath(asset: VoiceAsset): string {
    return join(this.options.paths.voiceDir, "installed", `${asset.id}.json`);
  }

  private isAssetInstalled(asset: VoiceAsset): boolean {
    const markerPath = this.markerPath(asset);
    if (!existsSync(markerPath)) return false;
    if (asset.kind === "npm") {
      return existsSync(join(this.options.paths.engineDir, "node_modules", asset.name, "package.json"));
    }
    return asset.verifyFiles.every((file) => existsSync(join(this.options.paths.modelsDir, file)));
  }

  getStatus(): VoiceInstallStatus {
    const supported = isVoiceTargetSupported(this.target);
    const assets = this.assets().map((asset): VoiceInstallAssetStatus => ({
      id: asset.id,
      label: assetLabel(asset),
      kind: asset.kind,
      sizeBytes: asset.sizeBytes,
      installed: this.isAssetInstalled(asset),
    }));
    const totalBytes = assets.reduce((sum, asset) => sum + asset.sizeBytes, 0);
    const remainingBytes = assets.filter((asset) => !asset.installed).reduce((sum, asset) => sum + asset.sizeBytes, 0);
    return {
      supported,
      target: this.target,
      installed: supported && assets.every((asset) => asset.installed),
      installing: !!this.installPromise,
      ...(this.progress ? { progress: this.progress } : {}),
      ...(this.lastError ? { error: this.lastError } : {}),
      totalBytes,
      remainingBytes,
      assets,
    };
  }

  onStatus(listener: (status: VoiceInstallStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    const status = this.getStatus();
    for (const listener of this.listeners) {
      try {
        listener(status);
      } catch {
        // Observers cannot break installation.
      }
    }
  }

  install(): Promise<void> {
    if (this.installPromise) return this.installPromise;
    if (!isVoiceTargetSupported(this.target)) {
      return Promise.reject(new Error(`Voice mode is not supported on ${this.target}`));
    }
    this.lastError = undefined;
    const run = this.runInstall()
      .catch((error: unknown) => {
        this.lastError = error instanceof Error ? error.message : String(error);
        this.logger.error(`[voice-install] ${this.lastError}`);
        throw error;
      })
      .finally(() => {
        this.installPromise = undefined;
        this.progress = undefined;
        this.emit();
      });
    this.installPromise = run;
    this.emit();
    return run;
  }

  private async runInstall(): Promise<void> {
    const { paths } = this.options;
    await mkdir(join(paths.engineDir, "node_modules"), { recursive: true });
    await mkdir(paths.modelsDir, { recursive: true });
    await mkdir(paths.downloadsDir, { recursive: true });
    await mkdir(join(paths.voiceDir, "installed"), { recursive: true });
    const enginePackageJson = join(paths.engineDir, "package.json");
    if (!existsSync(enginePackageJson)) {
      await writeFile(enginePackageJson, `${JSON.stringify({ name: "bridge-voice-engine", private: true }, null, 2)}\n`);
    }

    const pending = this.assets().filter((asset) => !this.isAssetInstalled(asset));
    const totalBytes = pending.reduce((sum, asset) => sum + asset.sizeBytes, 0) || 1;
    let completedBytes = 0;
    for (const asset of pending) {
      this.logger.log(`[voice-install] Installing ${assetLabel(asset)}`);
      const report = (phase: VoiceInstallProgress["phase"], receivedBytes: number, assetTotal: number) => {
        const fraction = assetTotal > 0 ? Math.min(1, receivedBytes / assetTotal) : 0;
        this.progress = {
          assetId: asset.id,
          label: assetLabel(asset),
          phase,
          receivedBytes,
          totalBytes: assetTotal,
          overallFraction: Math.min(0.999, (completedBytes + fraction * asset.sizeBytes) / totalBytes),
        };
        this.emit();
      };
      if (asset.kind === "npm") {
        await this.installPackage(asset, report);
      } else {
        await this.installModel(asset, report);
      }
      await writeFile(this.markerPath(asset), `${JSON.stringify({
        id: asset.id,
        digest: assetDigest(asset),
        layout: VOICE_ENGINE_LAYOUT_VERSION,
        installedAt: new Date().toISOString(),
      } satisfies AssetMarker, null, 2)}\n`);
      completedBytes += asset.sizeBytes;
    }
    this.logger.log("[voice-install] Voice engine installed");
  }

  private async download(
    asset: VoiceAsset,
    url: string,
    destination: string,
    algorithm: "sha256" | "sha512",
    report: (phase: VoiceInstallProgress["phase"], received: number, total: number) => void,
  ): Promise<string> {
    const partial = `${destination}.part`;
    await rm(partial, { force: true });
    const response = await this.fetchImpl(url, { redirect: "follow" });
    if (!response.ok || !response.body) {
      throw new Error(`Download failed for ${assetLabel(asset)} (HTTP ${response.status})`);
    }
    const headerLength = Number(response.headers.get("content-length"));
    const total = Number.isFinite(headerLength) && headerLength > 0 ? headerLength : asset.sizeBytes;
    const hash = createHash(algorithm);
    let received = 0;
    let lastReport = 0;
    const source = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);
    source.on("data", (chunk: Buffer) => {
      hash.update(chunk);
      received += chunk.length;
      const now = Date.now();
      if (now - lastReport > 250) {
        lastReport = now;
        report("downloading", received, total);
      }
    });
    await pipeline(source, createWriteStream(partial));
    report("verifying", received, total);
    const digest = algorithm === "sha256" ? hash.digest("hex") : hash.digest("base64");
    await rename(partial, destination);
    return digest;
  }

  private async installPackage(
    asset: VoiceNpmPackageAsset,
    report: (phase: VoiceInstallProgress["phase"], received: number, total: number) => void,
  ): Promise<void> {
    const { paths } = this.options;
    const archive = join(paths.downloadsDir, `${asset.name}-${asset.version}.tgz`);
    const digest = await this.download(asset, asset.tarballUrl, archive, "sha512", report);
    const expected = asset.integrity.replace(/^sha512-/, "");
    if (digest !== expected) {
      await rm(archive, { force: true });
      throw new Error(`Integrity check failed for ${assetLabel(asset)}`);
    }
    report("extracting", asset.sizeBytes, asset.sizeBytes);
    const staging = join(paths.engineDir, `.extract-${asset.id}`);
    await rm(staging, { recursive: true, force: true });
    await mkdir(staging, { recursive: true });
    try {
      await this.extract(archive, staging, {
        compression: "gzip",
        ...(asset.members ? { members: asset.members(this.target) } : {}),
      });
      const packageDir = join(staging, "package");
      const manifest = JSON.parse(await readFile(join(packageDir, "package.json"), "utf8")) as { name?: string; version?: string };
      if (manifest.name !== asset.name || manifest.version !== asset.version) {
        throw new Error(`Unexpected package contents in ${assetLabel(asset)}`);
      }
      const destination = join(paths.engineDir, "node_modules", asset.name);
      await rm(destination, { recursive: true, force: true });
      await mkdir(dirname(destination), { recursive: true });
      await rename(packageDir, destination);
    } finally {
      await rm(staging, { recursive: true, force: true });
      await rm(archive, { force: true });
    }
  }

  private async installModel(
    asset: VoiceModelAsset,
    report: (phase: VoiceInstallProgress["phase"], received: number, total: number) => void,
  ): Promise<void> {
    const { paths } = this.options;
    const downloadName = asset.fileName ?? basename(new URL(asset.url).pathname);
    const archive = join(paths.downloadsDir, downloadName);
    const digest = await this.download(asset, asset.url, archive, "sha256", report);
    if (digest !== asset.sha256) {
      await rm(archive, { force: true });
      throw new Error(`Integrity check failed for ${assetLabel(asset)}`);
    }
    if (asset.archive) {
      report("extracting", asset.sizeBytes, asset.sizeBytes);
      try {
        await this.extract(archive, paths.modelsDir, { compression: "bzip2" });
      } finally {
        await rm(archive, { force: true });
      }
    } else {
      await rename(archive, join(paths.modelsDir, asset.fileName!));
    }
    for (const file of asset.verifyFiles) {
      const fileStat = await stat(join(paths.modelsDir, file)).catch(() => undefined);
      if (!fileStat) throw new Error(`${assetLabel(asset)} is missing ${file} after install`);
    }
  }
}
