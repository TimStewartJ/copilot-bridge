#!/usr/bin/env node
import { register } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const APP_MODE_ARGS = new Set(["--server", "--headless", "--acp"]);

function isAppMode(args) {
  return process.env.COPILOT_RUN_APP === "1"
    || args.some((arg) => APP_MODE_ARGS.has(arg) || arg === "--prompt" || arg.startsWith("--prompt=") || arg === "-p" || (arg.startsWith("-p") && arg.length > 2));
}

const args = process.argv.slice(2);
const copilotPackageDir = dirname(dirname(fileURLToPath(import.meta.resolve("@github/copilot/sdk"))));
if (isAppMode(args)) {
  const appUrl = pathToFileURL(join(copilotPackageDir, "app.js")).href;
  process.env.BRIDGE_COPILOT_APP_URL = appUrl;
  register(new URL("./copilot-cli-loader.js", import.meta.url));
  await import(appUrl);
} else {
  await import(pathToFileURL(join(copilotPackageDir, "index.js")).href);
}
