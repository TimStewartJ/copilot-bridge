// Installs the voice engine on demand: pinned native npm packages and speech models,
// verified against published digests, into the voice data directory.
//
// Packages come through the machine's npm client and models over HTTPS. A verified archive
// that is already in the downloads folder is used as it is, so a host that can reach neither
// source can still be set up by copying the files in by hand.
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { moveFreshPath, resolveTarCommand } from "../platform.js";
import { getProcessHost } from "../process-host.js";
import { createNpmClient, describeNpmError, type NpmClient } from "./voice-npm-client.js";
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
  return async (archivePath, destination, options) => {
    // Run inside the destination with a relative archive path so no drive letter reaches tar.
    const args = [
      options.compression === "gzip" ? "-xzf" : "-xjf",
      relative(destination, archivePath),
      ...(options.members ?? []),
    ];
    try {
      await getProcessHost().execFile(tarCommand, args, { cwd: destination, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
    } catch (error) {
      const failure = error as { stderr?: unknown; message?: string };
      throw new Error(`Failed to extract ${basename(archivePath)}: ${String(failure.stderr || failure.message).trim()}`);
    }
  };
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
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  extract?: ExtractArchive;
  /** Defaults to the machine's npm client, found beside Node or on PATH. */
  npmClient?: NpmClient;
  /** Delay between retries of a file move that a scanner is blocking. Tests pass a no-op so they never sleep. */
  wait?: (delayMs: number) => Promise<void>;
  logger?: Pick<Console, "log" | "warn" | "error">;
}

type PhaseReport = (phase: VoiceInstallProgress["phase"], received: number, total: number) => void;

function assetLabel(asset: VoiceAsset): string {
  return asset.kind === "model" ? asset.label : `${asset.name} ${asset.version}`;
}

function assetDigest(asset: VoiceAsset): string {
  return asset.kind === "model" ? `sha256:${asset.sha256}` : asset.integrity;
}

/** Matches what `npm pack` and a browser download name the file, so a hand-copied archive is found. */
function archiveFileName(asset: VoiceAsset): string {
  if (asset.kind === "npm") return `${asset.name}-${asset.version}.tgz`;
  return asset.fileName ?? basename(new URL(asset.url).pathname);
}

/** Node reports every connection problem as "fetch failed"; the actual reason is on the cause chain. */
function describeNetworkError(error: unknown): string {
  let reason = error instanceof Error ? error.message : String(error);
  let cause = (error as { cause?: unknown } | undefined)?.cause;
  for (let depth = 0; cause && depth < 5; depth += 1) {
    const { code, message, cause: next } = cause as { code?: unknown; message?: unknown; cause?: unknown };
    if (typeof code === "string" && code) reason = code;
    else if (typeof message === "string" && message) reason = message;
    cause = next;
  }
  return reason;
}

/** Cleanup never fails an install that otherwise worked; a virus scanner may still hold the files. */
async function removeQuietly(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true }).catch(() => undefined);
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
  private npmClient?: NpmClient;

  constructor(private readonly options: VoiceInstallerOptions) {
    this.target = options.target ?? currentVoiceTarget();
    this.fetchImpl = options.fetch ?? fetch;
    this.extract = options.extract ?? createTarExtractor();
    this.logger = options.logger ?? console;
    this.npmClient = options.npmClient;
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
      const report: PhaseReport = (phase, receivedBytes, assetTotal) => {
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

  /** Whether the archive matches the digest pinned in the catalog. */
  private async matchesDigest(asset: VoiceAsset, archive: string, report: PhaseReport): Promise<boolean> {
    const size = (await stat(archive)).size;
    report("verifying", size, size);
    const hash = createHash(asset.kind === "npm" ? "sha512" : "sha256");
    for await (const chunk of createReadStream(archive, { highWaterMark: 1024 * 1024 })) hash.update(chunk as Buffer);
    return asset.kind === "npm"
      ? `sha512-${hash.digest("base64")}` === asset.integrity
      : hash.digest("hex") === asset.sha256;
  }

  private async download(asset: VoiceModelAsset, destination: string, report: PhaseReport): Promise<void> {
    const partial = `${destination}.part`;
    await rm(partial, { force: true });
    const response = await this.fetchImpl(asset.url, { redirect: "follow" });
    if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
    const headerLength = Number(response.headers.get("content-length"));
    const total = Number.isFinite(headerLength) && headerLength > 0 ? headerLength : asset.sizeBytes;
    let received = 0;
    let lastReport = 0;
    const source = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);
    source.on("data", (chunk: Buffer) => {
      received += chunk.length;
      const now = Date.now();
      if (now - lastReport > 250) {
        lastReport = now;
        report("downloading", received, total);
      }
    });
    await pipeline(source, createWriteStream(partial));
    await this.move(partial, destination);
  }

  private move(source: string, destination: string): Promise<void> {
    return moveFreshPath(source, destination, {
      ...(this.options.wait ? { wait: this.options.wait } : {}),
      log: (message) => this.logger.warn(`[voice-install] ${message}`),
    });
  }

  private async packWithNpm(asset: VoiceNpmPackageAsset, destination: string): Promise<void> {
    this.npmClient ??= createNpmClient({ env: this.options.env });
    const scratch = join(this.options.paths.downloadsDir, `npm-${asset.id}`);
    try {
      await this.move(await this.npmClient.pack(`${asset.name}@${asset.version}`, scratch), destination);
    } finally {
      await removeQuietly(scratch);
    }
  }

  /** Leaves a digest-verified archive in the downloads folder and returns its path. */
  private async obtainArchive(asset: VoiceAsset, report: PhaseReport): Promise<string> {
    const { downloadsDir } = this.options.paths;
    const fileName = archiveFileName(asset);
    const archive = join(downloadsDir, fileName);
    let rejectedCopy = false;
    if (existsSync(archive)) {
      // Copied in by hand for a host that can't download it, or kept from a run whose unpack step failed.
      if (await this.matchesDigest(asset, archive, report)) {
        this.logger.log(`[voice-install] Using ${fileName} from the downloads folder`);
        return archive;
      }
      rejectedCopy = true;
      await removeQuietly(archive);
    }
    report("downloading", 0, asset.sizeBytes);
    try {
      if (asset.kind === "npm") await this.packWithNpm(asset, archive);
      else await this.download(asset, archive, report);
    } catch (error) {
      const [route, reason, byHand] = asset.kind === "npm"
        ? ["with npm", describeNpmError(error), `run "npm pack ${asset.name}@${asset.version}"`]
        : [`from ${new URL(asset.url).host}`, describeNetworkError(error), `download ${asset.url}`];
      throw new Error(
        `Couldn't download ${assetLabel(asset)} ${route}: ${reason}. `
        + `To add it by hand, ${byHand} on any computer, copy ${fileName} into ${downloadsDir}, then retry.`
        + (rejectedCopy ? ` The ${fileName} that was already there did not match the expected digest and was removed.` : ""),
      );
    }
    if (!(await this.matchesDigest(asset, archive, report))) {
      await removeQuietly(archive);
      throw new Error(`Integrity check failed for ${assetLabel(asset)}`);
    }
    return archive;
  }

  private async installPackage(asset: VoiceNpmPackageAsset, report: PhaseReport): Promise<void> {
    const { paths } = this.options;
    const archive = await this.obtainArchive(asset, report);
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
      await this.move(packageDir, destination);
    } finally {
      await removeQuietly(staging);
    }
    // Only a finished install gives up the verified archive, so a failed unpack never costs a second download.
    await removeQuietly(archive);
  }

  private async installModel(asset: VoiceModelAsset, report: PhaseReport): Promise<void> {
    const { paths } = this.options;
    const archive = await this.obtainArchive(asset, report);
    if (asset.archive) {
      report("extracting", asset.sizeBytes, asset.sizeBytes);
      await this.extract(archive, paths.modelsDir, { compression: "bzip2" });
    } else {
      await this.move(archive, join(paths.modelsDir, asset.fileName!));
    }
    for (const file of asset.verifyFiles) {
      const fileStat = await stat(join(paths.modelsDir, file)).catch(() => undefined);
      if (!fileStat) throw new Error(`${assetLabel(asset)} is missing ${file} after install`);
    }
    await removeQuietly(archive);
  }
}
