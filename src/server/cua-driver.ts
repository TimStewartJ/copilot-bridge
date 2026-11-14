// Cua Driver (github.com/trycua/cua) as the Bridge's desktop automation engine: a pinned
// release installed on demand into the data directory, run by each chat as its own MCP server.
// The Bridge keeps one connection per chat because Cua's element tokens belong to a connection.
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { LocalMcpServerConfig } from "./mcp-config.js";
import { moveFreshPath, resolveTarCommand } from "./platform.js";
import { getProcessHost } from "./process-host.js";

export const CUA_MCP_SERVER_NAME = "cua";

interface CuaAsset {
  fileName: string;
  sha256: string;
  sizeBytes: number;
}

/** Bump together: the release tag, its version and each asset's digest from the release page. */
export const CUA_DRIVER_RELEASE = {
  version: "0.49.5",
  tag: "cua-driver-rs-v0.49.5",
  assets: {
    "win32-x64": {
      fileName: "cua-driver-rs-0.49.5-windows-x86_64-binary.zip",
      sha256: "b19c4a8613df17184005ddf14a930f51c3d403b06364656acd899498059f711f",
      sizeBytes: 32_317_981,
    },
    "win32-arm64": {
      fileName: "cua-driver-rs-0.49.5-windows-arm64-binary.zip",
      sha256: "bc82e0dc0f095a00beb1039af729fdc3cffb1b29581dc75523aa9cbc439d1053",
      sizeBytes: 30_133_066,
    },
  } as Record<string, CuaAsset>,
} as const;

/**
 * The desktop tools chats get. Cua's browser tools are left out because the Bridge has its own,
 * and so are its update, configuration, extension, recording and agent-cursor tools.
 */
export const CUA_TOOLS = [
  "list_apps", "list_windows", "launch_app", "kill_app", "bring_to_front", "set_window_frame",
  "get_window_state", "verify_state", "zoom", "get_desktop_state", "get_screen_size", "get_cursor_position",
  "click", "double_click", "right_click", "drag", "scroll", "type_text", "press_key", "hotkey", "set_value",
  "invoke_menu", "run_steps", "run_script", "clipboard_read", "clipboard_write",
  "get_guide", "health_report", "check_permissions", "debug_window_info",
] as const;

export interface CuaDriverStatus {
  supported: boolean;
  installed: boolean;
  version: string;
  installing: boolean;
  executablePath?: string;
  error?: string;
}

export function cuaDriverTarget(platform: NodeJS.Platform = process.platform, arch: string = process.arch): string {
  return `${platform}-${arch}`;
}

export function getCuaInstallDir(dataDir: string): string {
  return join(dataDir, "cua-driver", CUA_DRIVER_RELEASE.version);
}

export function getCuaExecutablePath(dataDir: string): string {
  return join(getCuaInstallDir(dataDir), "cua-driver.exe");
}

export function buildCuaMcpServerConfig(executablePath: string): LocalMcpServerConfig & { deferTools: "auto" } {
  return {
    type: "local",
    command: executablePath,
    // --direct runs the driver inside this process instead of attaching to a daemon someone else started.
    args: ["mcp", "--direct"],
    env: { DO_NOT_TRACK: "1", CUA_DRIVER_RS_UPDATE_CHECK: "false" },
    tools: [...CUA_TOOLS],
    executionScope: "session",
    // About 50k tokens of tool definitions: loaded through tool search only in chats that drive the desktop.
    deferTools: "auto",
  };
}

/** Accepts the runtime's MCP tool names (`cua-click`) as well as Cua's own (`click`). */
export function cuaToolName(toolName: string): string | undefined {
  if (toolName.startsWith(`${CUA_MCP_SERVER_NAME}-`)) return toolName.slice(CUA_MCP_SERVER_NAME.length + 1);
  return (CUA_TOOLS as readonly string[]).includes(toolName) ? toolName : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const INPUT_TOOLS = new Set(["click", "double_click", "right_click", "drag", "scroll", "type_text", "press_key", "hotkey"]);

/**
 * Whether a Cua call would bring a window to the front or send real input. A safety net for a
 * cooperating agent: a script can still build a foreground call from computed strings.
 */
export function cuaCallTakesForeground(tool: string, args: unknown): boolean {
  if (tool === "bring_to_front" || tool === "invoke_menu") return true;
  if (!isRecord(args)) return INPUT_TOOLS.has(tool);
  if (args.delivery_mode === "foreground" || args.foreground_fallback === true) return true;
  // Without a pid the input goes to the whole visible desktop, not one window in the background.
  if (INPUT_TOOLS.has(tool) && args.pid === undefined) return true;
  if (tool === "run_steps" && Array.isArray(args.steps)) {
    return args.steps.some((step) => isRecord(step) && typeof step.tool === "string" && cuaCallTakesForeground(step.tool, step.args));
  }
  if (tool === "run_script" && typeof args.script === "string") {
    return /bring_?to_?front|foreground|invoke_?menu/i.test(args.script);
  }
  return false;
}

export interface CuaForegroundGuardOptions {
  awayAfterMinutes: number;
  readIdleSeconds: () => Promise<number | undefined>;
  now?: () => number;
}

export interface CuaForegroundDecision {
  permissionDecision: "deny";
  permissionDecisionReason: string;
}

/** Input this soon after a Cua call ends is taken to be that call's own. */
const OWN_INPUT_GRACE_MS = 3_000;

/**
 * Refuses Cua calls that would take the foreground while the user is at the PC, so their typing
 * never lands in the wrong window. Cua's own input resets Windows' idle timer, so once a chat has
 * taken over, input during or just after its Cua calls doesn't count as the user coming back.
 */
export function createCuaForegroundGuard(options: CuaForegroundGuardOptions) {
  const now = options.now ?? Date.now;
  let takenOver = false;
  let runningCalls = 0;
  let lastCallEndedAt = 0;

  const deny = (permissionDecisionReason: string): CuaForegroundDecision => ({ permissionDecision: "deny", permissionDecisionReason });

  async function decide(tool: string, args: unknown): Promise<CuaForegroundDecision | undefined> {
    if (!cuaCallTakesForeground(tool, args)) return undefined;
    const idle = await options.readIdleSeconds();
    if (idle === undefined) {
      takenOver = false;
      return deny("Couldn't tell whether the user is at this PC, so the foreground stays theirs. Use background delivery, or ask the user.");
    }
    if (idle >= options.awayAfterMinutes * 60) {
      takenOver = true;
      return undefined;
    }
    const lastInputAt = now() - idle * 1000;
    if (takenOver && (runningCalls > 0 || lastInputAt <= lastCallEndedAt + OWN_INPUT_GRACE_MS)) return undefined;
    takenOver = false;
    return deny(
      `The user is using this PC (last input ${Math.round(idle)} s ago; away means ${options.awayAfterMinutes} min without input). `
      + "Use background delivery, wait until they have been away that long, or ask the user.",
    );
  }

  return {
    beforeToolUse: async (input: { toolName: string; toolArgs: unknown }): Promise<CuaForegroundDecision | undefined> => {
      const tool = cuaToolName(input.toolName);
      if (!tool) return undefined;
      try {
        const decision = await decide(tool, input.toolArgs);
        if (!decision) runningCalls += 1;
        return decision;
      } catch {
        // The runtime allows a call whose hook throws, so a failed check refuses here.
        return deny("The Bridge couldn't check whether the user is at this PC. Use background delivery, or ask the user.");
      }
    },
    afterToolUse: (input: { toolName: string }): void => {
      if (!cuaToolName(input.toolName)) return;
      runningCalls = Math.max(0, runningCalls - 1);
      lastCallEndedAt = now();
    },
  };
}

export interface CuaInstallerOptions {
  dataDir: string;
  target?: string;
  fetch?: typeof fetch;
  /** Unpacks the zip into an empty folder. Defaults to the system tar, which reads zip files. */
  extract?: (archivePath: string, destination: string) => Promise<void>;
  wait?: (delayMs: number) => Promise<void>;
  logger?: Pick<Console, "log" | "warn" | "error">;
}

function createZipExtractor(tarCommand = resolveTarCommand()): (archivePath: string, destination: string) => Promise<void> {
  return async (archivePath, destination) => {
    // Run inside the destination with a relative archive path so no drive letter reaches tar.
    try {
      await getProcessHost().execFile(tarCommand, ["-xf", relative(destination, archivePath)], {
        cwd: destination,
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
      });
    } catch (error) {
      const failure = error as { stderr?: unknown; message?: string };
      throw new Error(`Failed to extract ${basename(archivePath)}: ${String(failure.stderr || failure.message).trim()}`);
    }
  };
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path, { highWaterMark: 1024 * 1024 })) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

async function removeQuietly(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true }).catch(() => undefined);
}

export class CuaDriverInstaller {
  private installPromise?: Promise<void>;
  private lastError?: string;
  private readonly target: string;
  private readonly fetchImpl: typeof fetch;
  private readonly extract: (archivePath: string, destination: string) => Promise<void>;
  private readonly logger: Pick<Console, "log" | "warn" | "error">;

  constructor(private readonly options: CuaInstallerOptions) {
    this.target = options.target ?? cuaDriverTarget();
    this.fetchImpl = options.fetch ?? fetch;
    this.extract = options.extract ?? createZipExtractor();
    this.logger = options.logger ?? console;
  }

  private get asset(): CuaAsset | undefined {
    return CUA_DRIVER_RELEASE.assets[this.target];
  }

  private markerPath(): string {
    return join(getCuaInstallDir(this.options.dataDir), "installed.json");
  }

  getStatus(): CuaDriverStatus {
    const executablePath = getCuaExecutablePath(this.options.dataDir);
    const installed = !!this.asset && existsSync(this.markerPath()) && existsSync(executablePath);
    return {
      supported: !!this.asset,
      installed,
      version: CUA_DRIVER_RELEASE.version,
      installing: !!this.installPromise,
      ...(installed ? { executablePath } : {}),
      ...(this.lastError ? { error: this.lastError } : {}),
    };
  }

  install(): Promise<void> {
    if (this.installPromise) return this.installPromise;
    const asset = this.asset;
    if (!asset) return Promise.reject(new Error(`Cua Driver is not available for ${this.target}`));
    if (this.getStatus().installed) return Promise.resolve();
    this.lastError = undefined;
    const run = this.runInstall(asset)
      .catch((error: unknown) => {
        this.lastError = error instanceof Error ? error.message : String(error);
        this.logger.error(`[cua-install] ${this.lastError}`);
        throw error;
      })
      .finally(() => {
        this.installPromise = undefined;
      });
    this.installPromise = run;
    return run;
  }

  private async runInstall(asset: CuaAsset): Promise<void> {
    const root = join(this.options.dataDir, "cua-driver");
    const downloads = join(root, "downloads");
    const installDir = getCuaInstallDir(this.options.dataDir);
    const staging = join(root, `.extract-${CUA_DRIVER_RELEASE.version}-${randomUUID()}`);
    const archive = join(downloads, asset.fileName);
    await mkdir(downloads, { recursive: true });

    if (!existsSync(archive) || (await sha256File(archive)) !== asset.sha256) {
      await removeQuietly(archive);
      const url = `https://github.com/trycua/cua/releases/download/${CUA_DRIVER_RELEASE.tag}/${asset.fileName}`;
      this.logger.log(`[cua-install] Downloading ${url}`);
      const partial = `${archive}.part`;
      await rm(partial, { force: true });
      const response = await this.fetchImpl(url, { redirect: "follow" });
      if (!response.ok || !response.body) throw new Error(`Couldn't download Cua Driver: HTTP ${response.status}`);
      const source = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);
      let received = 0;
      source.on("data", (chunk: Buffer) => {
        received += chunk.length;
        if (received > asset.sizeBytes) source.destroy(new Error(`Cua Driver download is larger than the expected ${asset.sizeBytes} bytes`));
      });
      await pipeline(source, createWriteStream(partial)).catch(async (error: unknown) => {
        await removeQuietly(partial);
        throw error;
      });
      if ((await sha256File(partial)) !== asset.sha256) {
        await removeQuietly(partial);
        throw new Error(`Cua Driver ${CUA_DRIVER_RELEASE.version} failed its integrity check`);
      }
      await moveFreshPath(partial, archive, this.moveOptions());
    }

    await removeQuietly(staging);
    await mkdir(staging, { recursive: true });
    try {
      await this.extract(archive, staging);
      if (!(await stat(join(staging, "cua-driver.exe")).catch(() => undefined))) {
        throw new Error(`${asset.fileName} does not contain cua-driver.exe`);
      }
      await removeQuietly(installDir);
      await mkdir(root, { recursive: true });
      await moveFreshPath(staging, installDir, this.moveOptions());
    } finally {
      await removeQuietly(staging);
    }
    await writeFile(this.markerPath(), `${JSON.stringify({
      version: CUA_DRIVER_RELEASE.version,
      sha256: asset.sha256,
      installedAt: new Date().toISOString(),
    }, null, 2)}\n`);
    await removeQuietly(archive);
    this.logger.log(`[cua-install] Cua Driver ${CUA_DRIVER_RELEASE.version} installed`);
  }

  private moveOptions() {
    return {
      ...(this.options.wait ? { wait: this.options.wait } : {}),
      log: (message: string) => this.logger.warn(`[cua-install] ${message}`),
    };
  }
}
