import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const BUILD_STAMP_VERSION = 1;
const BUILD_STAMP_FILE = ".bridge-build-stamp.json";
const BUILD_INPUT_PATHS = [
  "src",
  "public",
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "tsconfig.client.json",
  "vite.config.ts",
] as const;
const REQUIRED_BUILD_OUTPUTS = [
  join("dist", "client", "index.html"),
  join("dist", "server", "index.js"),
] as const;

// This prevents accidental stale packaging; it is not a signed build attestation.
export interface BuildStamp {
  version: number;
  commitSha: string;
  inputHash: string;
  outputHash: string;
  builtAt: string;
}

function normalizePath(value: string): string {
  return value.replaceAll("\\", "/");
}

function collectFiles(rootDir: string, path: string, files: string[]): void {
  const absolutePath = join(rootDir, path);
  if (!existsSync(absolutePath)) {
    files.push(`${normalizePath(path)}:<missing>`);
    return;
  }

  const stat = lstatSync(absolutePath);
  if (stat.isSymbolicLink()) {
    throw new Error(`Build stamp does not support symbolic-link inputs: ${path}`);
  }
  if (stat.isFile()) {
    files.push(normalizePath(path));
    return;
  }
  if (!stat.isDirectory()) {
    throw new Error(`Unsupported build input type: ${path}`);
  }

  for (const entry of readdirSync(absolutePath, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    collectFiles(rootDir, join(path, entry.name), files);
  }
}

function hashPaths(rootDir: string, paths: readonly string[], excludedRelativePath?: string): string {
  const files: string[] = [];
  for (const path of paths) {
    collectFiles(rootDir, path, files);
  }

  const hash = createHash("sha256");
  const normalizedExcludedPath = excludedRelativePath ? normalizePath(excludedRelativePath) : undefined;
  for (const file of files.sort()) {
    if (file === normalizedExcludedPath) continue;
    hash.update(file);
    hash.update("\0");
    if (!file.endsWith(":<missing>")) {
      hash.update(readFileSync(join(rootDir, file)));
    }
    hash.update("\0");
  }
  return hash.digest("hex");
}

function readCommitSha(rootDir: string): string {
  return execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: rootDir,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function stampPath(rootDir: string): string {
  return join(rootDir, "dist", BUILD_STAMP_FILE);
}

function assertRequiredBuildOutputs(rootDir: string): void {
  const missing = REQUIRED_BUILD_OUTPUTS.filter((path) => !existsSync(join(rootDir, path)));
  if (missing.length > 0) {
    throw new Error(`Build output is incomplete; missing ${missing.map(normalizePath).join(", ")}`);
  }
}

function readStamp(rootDir: string): BuildStamp {
  const path = stampPath(rootDir);
  if (!existsSync(path)) {
    throw new Error("Prebuilt release requires a current dist/.bridge-build-stamp.json; run npm run build first.");
  }
  const parsed = JSON.parse(readFileSync(path, "utf-8")) as Partial<BuildStamp>;
  if (
    parsed.version !== BUILD_STAMP_VERSION
    || typeof parsed.commitSha !== "string"
    || typeof parsed.inputHash !== "string"
    || typeof parsed.outputHash !== "string"
    || typeof parsed.builtAt !== "string"
  ) {
    throw new Error("Build stamp is malformed or uses an unsupported version; run npm run build again.");
  }
  return parsed as BuildStamp;
}

export function createBuildStamp(rootDir = process.cwd(), commitSha = readCommitSha(rootDir)): BuildStamp {
  const resolvedRoot = resolve(rootDir);
  assertRequiredBuildOutputs(resolvedRoot);
  return {
    version: BUILD_STAMP_VERSION,
    commitSha,
    inputHash: hashPaths(resolvedRoot, BUILD_INPUT_PATHS),
    outputHash: hashPaths(resolvedRoot, ["dist"], join("dist", BUILD_STAMP_FILE)),
    builtAt: new Date().toISOString(),
  };
}

export function writeBuildStamp(rootDir = process.cwd(), commitSha?: string): BuildStamp {
  const resolvedRoot = resolve(rootDir);
  const stamp = createBuildStamp(resolvedRoot, commitSha ?? readCommitSha(resolvedRoot));
  writeFileSync(stampPath(resolvedRoot), `${JSON.stringify(stamp, null, 2)}\n`);
  return stamp;
}

export function verifyBuildStamp(rootDir = process.cwd(), commitSha?: string): BuildStamp {
  const resolvedRoot = resolve(rootDir);
  assertRequiredBuildOutputs(resolvedRoot);
  const stamp = readStamp(resolvedRoot);
  const currentCommitSha = commitSha ?? readCommitSha(resolvedRoot);
  if (stamp.commitSha !== currentCommitSha) {
    throw new Error("Prebuilt release stamp does not match the current commit; run npm run build again.");
  }
  const inputHash = hashPaths(resolvedRoot, BUILD_INPUT_PATHS);
  if (stamp.inputHash !== inputHash) {
    throw new Error("Build inputs changed after the prebuilt output was created; run npm run build again.");
  }
  const outputHash = hashPaths(resolvedRoot, ["dist"], join("dist", BUILD_STAMP_FILE));
  if (stamp.outputHash !== outputHash) {
    throw new Error("Build output changed after validation; run npm run build again.");
  }
  return stamp;
}

function isDirectExecution(): boolean {
  const entry = process.argv[1];
  return Boolean(entry) && resolve(entry) === fileURLToPath(import.meta.url);
}

if (isDirectExecution()) {
  const command = process.argv[2];
  if (command === "write") {
    const stamp = writeBuildStamp();
    process.stdout.write(`Wrote build stamp for ${stamp.commitSha}.\n`);
  } else if (command === "verify") {
    const stamp = verifyBuildStamp();
    process.stdout.write(`Verified prebuilt output for ${stamp.commitSha}.\n`);
  } else {
    throw new Error("Usage: tsx src/server/build-stamp.ts <write|verify>");
  }
}
