#!/usr/bin/env node
import { existsSync } from "node:fs";
import { register } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const APP_MODE_ARGS = new Set(["--server", "--headless", "--acp"]);

function isAppMode(args) {
  return process.env.COPILOT_RUN_APP === "1"
    || args.some((arg) => APP_MODE_ARGS.has(arg) || arg === "--prompt" || arg.startsWith("--prompt=") || arg === "-p" || (arg.startsWith("-p") && arg.length > 2));
}

function resolveCopilotPackageDir() {
  // The Bridge server sets this to the pinned CLI build (see copilot-cli-pin.ts)
  // only after the directory passed its readiness check, so a missing or broken
  // value is a real fault and must not silently launch a different CLI version.
  const pinnedDir = process.env.BRIDGE_COPILOT_APP_DIR;
  if (!pinnedDir || !pinnedDir.trim()) {
    throw new Error("BRIDGE_COPILOT_APP_DIR is not set; Bridge only launches the pinned Copilot CLI build.");
  }
  if (existsSync(join(pinnedDir, "app.js")) && existsSync(join(pinnedDir, "index.js"))) {
    return pinnedDir;
  }
  throw new Error(
    `BRIDGE_COPILOT_APP_DIR=${pinnedDir} does not contain the Copilot application entry points (app.js/index.js).`,
  );
}

const args = process.argv.slice(2);
const copilotPackageDir = resolveCopilotPackageDir();
if (isAppMode(args)) {
  const appUrl = pathToFileURL(join(copilotPackageDir, "app.js")).href;
  process.env.BRIDGE_COPILOT_APP_URL = appUrl;
  register(new URL("./copilot-cli-loader.js", import.meta.url));
  await import(appUrl);
} else {
  await import(pathToFileURL(join(copilotPackageDir, "index.js")).href);
}
