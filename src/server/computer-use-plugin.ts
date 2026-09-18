// Locates the Computer Use plugin that ships inside the Copilot SDK platform package.
// Sessions load it through the SDK's `pluginDirectories` option, so the runtime reads
// upstream's own plugin manifest and the Bridge setting is the only gate.

import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

export const COMPUTER_USE_PLUGIN_NAME = "computer-use";

export interface ComputerUsePluginStatus {
  available: boolean;
  pluginDirectory?: string;
  version?: string;
  reason?: string;
}

export interface ResolveComputerUsePluginOptions {
  platform?: NodeJS.Platform;
  arch?: string;
  resolvePackageRoot?: (packageName: string) => string | undefined;
}

const require = createRequire(import.meta.url);

function resolveSdkPlatformPackageRoot(packageName: string): string | undefined {
  try {
    // Resolve from the SDK's own location so nested and hoisted installs both work.
    const sdkRequire = createRequire(require.resolve("@github/copilot-sdk"));
    return dirname(sdkRequire.resolve(`${packageName}/package.json`));
  } catch {
    return undefined;
  }
}

function sdkPlatformPackageNames(platform: NodeJS.Platform, arch: string): string[] {
  const targets = platform === "linux" ? [`linux-${arch}`, `linuxmusl-${arch}`] : [`${platform}-${arch}`];
  return targets.map((target) => `@github/copilot-sdk-${target}`);
}

export function resolveComputerUsePlugin(options: ResolveComputerUsePluginOptions = {}): ComputerUsePluginStatus {
  const resolvePackageRoot = options.resolvePackageRoot ?? resolveSdkPlatformPackageRoot;
  const packageNames = sdkPlatformPackageNames(options.platform ?? process.platform, options.arch ?? process.arch);

  for (const packageName of packageNames) {
    const packageRoot = resolvePackageRoot(packageName);
    if (!packageRoot) continue;

    const pluginDirectory = join(packageRoot, "plugins", COMPUTER_USE_PLUGIN_NAME);
    const manifestPath = join(pluginDirectory, ".plugin", "plugin.json");
    if (!existsSync(manifestPath)) {
      return { available: false, reason: `${packageName} does not include the Computer Use plugin.` };
    }
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as { name?: unknown; version?: unknown };
      if (manifest.name !== COMPUTER_USE_PLUGIN_NAME) {
        return { available: false, reason: `${manifestPath} does not describe the ${COMPUTER_USE_PLUGIN_NAME} plugin.` };
      }
      return {
        available: true,
        pluginDirectory,
        ...(typeof manifest.version === "string" ? { version: manifest.version } : {}),
      };
    } catch (error) {
      return {
        available: false,
        reason: `The Computer Use plugin manifest could not be read: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  return {
    available: false,
    reason: `The Copilot SDK platform package (${packageNames.join(" or ")}) is not installed.`,
  };
}
