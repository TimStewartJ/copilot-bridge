#!/usr/bin/env node
import { existsSync } from "node:fs";
import { register } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const APP_MODE_ARGS = new Set(["--server", "--headless", "--acp"]);

function isAppMode(args) {
  return process.env.COPILOT_RUN_APP === "1"
    || args.some((arg) => APP_MODE_ARGS.has(arg) || arg === "--prompt" || arg.startsWith("--prompt=") || arg === "-p" || (arg.startsWith("-p") && arg.length > 2));
}

async function prefersMuslLinux() {
  try {
    const { isNonGlibcLinuxSync } = await import("detect-libc");
    return isNonGlibcLinuxSync();
  } catch {
    try {
      const glibc = process.report?.getReport?.()?.header?.glibcVersionRuntime;
      return !(typeof glibc === "string" && glibc.length > 0);
    } catch {
      return undefined;
    }
  }
}

async function platformPackageVariants() {
  if (process.platform !== "linux") return [process.platform];
  const musl = await prefersMuslLinux();
  if (musl === true) return ["linuxmusl", "linux"];
  if (musl === false) return ["linux", "linuxmusl"];
  return ["linux", "linuxmusl"];
}

async function resolveCopilotPackageDir() {
  const arch = process.arch;
  for (const variant of await platformPackageVariants()) {
    try {
      const sdkPath = fileURLToPath(import.meta.resolve(`@github/copilot-${variant}-${arch}/sdk`));
      const packageDir = dirname(dirname(sdkPath));
      if (existsSync(join(packageDir, "app.js")) && existsSync(join(packageDir, "index.js"))) {
        return packageDir;
      }
    } catch {
      // The optional dependency for another libc/platform is not installed.
    }
  }
  throw new Error(
    "Unable to locate the platform-specific @github/copilot application entry points (app.js/index.js).",
  );
}

const args = process.argv.slice(2);
const copilotPackageDir = await resolveCopilotPackageDir();
if (isAppMode(args)) {
  const appUrl = pathToFileURL(join(copilotPackageDir, "app.js")).href;
  process.env.BRIDGE_COPILOT_APP_URL = appUrl;
  register(new URL("./copilot-cli-loader.js", import.meta.url));
  await import(appUrl);
} else {
  await import(pathToFileURL(join(copilotPackageDir, "index.js")).href);
}
