#!/usr/bin/env node
// In-tree packages (src/packages/*) are published on their own. This script checks and builds
// them the way a consumer gets them. It never writes under src/: the Bridge build stamp hashes
// that tree, so build output goes to a directory outside the repository.
//
//   typecheck               type-check every package with its own tsconfig, not the Bridge's
//   pack   [--out <dir>]    compile every package and write an installable tarball for each
//   verify [--out <dir>]    pack, install the tarballs into a scratch project, run each smoke test
//
// Without --out both work in a new temporary directory. pack prints it, because the tarballs are
// its result. verify removes it once everything passed and leaves it in place after a failure.
// Add package names or folder names after the command to limit it to those packages.
//
// A tarball from pack is what a release publishes (see src/packages/README.md). Its package.json
// is the folder's without "private", which stays in the folder so npm refuses to publish the
// source, and with the commit it was built from as gitHead.

import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packagesDir = join(repoRoot, "src", "packages");
const tscCli = join(repoRoot, "node_modules", "typescript", "bin", "tsc");
const REQUIRED_TARBALL_FILES = ["package.json", "README.md", "LICENSE", "dist/index.js", "dist/index.d.ts"];
const FORBIDDEN_TARBALL_PATH = /(^|\/)(src|test)\/|\.test\.|\.ts$(?<!\.d\.ts)/;

function fail(message) {
  console.error(`[packages] ${message}`);
  process.exit(1);
}

/** The path as the file system spells it: links resolved and letter case as stored, even if its tail does not exist yet. */
function canonicalPath(path) {
  const missing = [];
  let existing = resolve(path);
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) return resolve(path);
    missing.unshift(basename(existing));
    existing = parent;
  }
  return join(realpathSync.native(existing), ...missing);
}

function isInsideOrSame(directory, path) {
  const fromDirectory = relative(canonicalPath(directory), canonicalPath(path));
  return fromDirectory === "" || (fromDirectory.split(sep)[0] !== ".." && !isAbsolute(fromDirectory));
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: options.capture ? ["ignore", "pipe", "inherit"] : "inherit", encoding: "utf8", cwd: options.cwd });
  if (result.error) fail(`${command} could not start: ${result.error.message}`);
  if (result.status !== 0) fail(`${[command, ...args].join(" ")} exited with code ${result.status}`);
  return result.stdout ?? "";
}

/** How to run npm without a shell: the Windows npm.cmd shim needs one, so its npm-cli.js is run with Node. */
function npmInvocation() {
  const fromNpmRun = process.env.npm_execpath;
  if (fromNpmRun && /npm-cli\.js$/.test(fromNpmRun) && existsSync(fromNpmRun)) return [process.execPath, [fromNpmRun]];
  const cliSegments = ["node_modules", "npm", "bin", "npm-cli.js"];
  const execDir = dirname(process.execPath);
  const bundled = process.platform === "win32" ? join(execDir, ...cliSegments) : join(execDir, "..", "lib", ...cliSegments);
  if (existsSync(bundled)) return [process.execPath, [bundled]];
  if (process.platform !== "win32") return ["npm", []];
  const pathKey = Object.keys(process.env).find((key) => key.toUpperCase() === "PATH");
  for (const dir of (pathKey ? process.env[pathKey] ?? "" : "").split(delimiter).filter(Boolean)) {
    const cli = join(dir, ...cliSegments);
    if (existsSync(join(dir, "npm.cmd")) && existsSync(cli)) return [process.execPath, [cli]];
  }
  return fail("npm was not found beside Node or on PATH");
}

function npm(args, options) {
  const [command, prefix] = npmInvocation();
  return run(command, [...prefix, ...args], options);
}

function listPackages(only) {
  const all = readdirSync(packagesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(packagesDir, entry.name, "package.json")))
    .map((entry) => {
      const dir = join(packagesDir, entry.name);
      return { dir, manifest: JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) };
    });
  // A scoped name starts with "@", which PowerShell reads as an operator, so the folder name works too.
  const isNamed = (entry, wanted) => entry.manifest.name === wanted || basename(entry.dir) === wanted;
  const unknown = only.filter((wanted) => !all.some((entry) => isNamed(entry, wanted)));
  if (unknown.length > 0) fail(`unknown package(s): ${unknown.join(", ")}. Known: ${all.map((entry) => basename(entry.dir)).join(", ")}`);
  return only.length > 0 ? all.filter((entry) => only.some((wanted) => isNamed(entry, wanted))) : all;
}

/** A package name as npm writes it in a file name: "@scope/name" becomes "scope-name". */
function fileSlug(name) {
  return name.replace(/^@/, "").replace(/\//g, "-");
}

/** The commit a package's files come from. Undefined when they differ from it, or outside a git checkout. */
function sourceCommit(dir) {
  const git = (args) => spawnSync("git", args, { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  const head = git(["rev-parse", "HEAD"]);
  const changes = git(["status", "--porcelain", "--", dir]);
  if (head.status !== 0 || changes.status !== 0 || changes.stdout.trim()) return undefined;
  return head.stdout.trim();
}

function typecheck(packages) {
  for (const { dir, manifest } of packages) {
    console.log(`[packages] type-checking ${manifest.name}`);
    run(process.execPath, [tscCli, "--noEmit", "-p", join(dir, "tsconfig.json")]);
  }
}

function pack(packages, outRoot) {
  const tarballs = [];
  for (const { dir, manifest } of packages) {
    const stage = join(outRoot, fileSlug(manifest.name));
    rmSync(stage, { recursive: true, force: true });
    mkdirSync(stage, { recursive: true });
    console.log(`[packages] building ${manifest.name}@${manifest.version}`);
    run(process.execPath, [tscCli, "-p", join(dir, "tsconfig.build.json"), "--noEmit", "false", "--outDir", join(stage, "dist")]);
    const { private: _folderOnly, ...publishable } = manifest;
    const gitHead = sourceCommit(dir);
    if (gitHead) publishable.gitHead = gitHead;
    else console.log(`[packages] ${manifest.name}: has local changes or is not in a git checkout, so the tarball records no gitHead`);
    writeFileSync(join(stage, "package.json"), `${JSON.stringify(publishable, null, 2)}\n`);
    // npm packs these two whatever "files" says. The changelog stays in the repository.
    for (const file of ["README.md", "LICENSE"]) {
      if (existsSync(join(dir, file))) cpSync(join(dir, file), join(stage, file));
    }

    const [packed] = JSON.parse(npm(["pack", "--json", "--pack-destination", outRoot], { cwd: stage, capture: true }));
    const files = packed.files.map((file) => file.path);
    const missing = REQUIRED_TARBALL_FILES.filter((file) => !files.includes(file));
    const forbidden = files.filter((file) => FORBIDDEN_TARBALL_PATH.test(file));
    if (missing.length > 0) fail(`${manifest.name} tarball is missing ${missing.join(", ")}`);
    if (forbidden.length > 0) fail(`${manifest.name} tarball contains source or test files: ${forbidden.join(", ")}`);
    const tarball = join(outRoot, packed.filename);
    console.log(`[packages] ${manifest.name}: ${files.length} files, ${packed.size} bytes packed, ${packed.unpackedSize} unpacked -> ${tarball}`);
    tarballs.push({ dir, manifest, tarball });
  }
  return tarballs;
}

function verify(packages, outRoot) {
  const tarballs = pack(packages, outRoot);
  const consumer = join(outRoot, "consumer");
  rmSync(consumer, { recursive: true, force: true });
  mkdirSync(consumer, { recursive: true });
  writeFileSync(join(consumer, "package.json"), `${JSON.stringify({ name: "packages-consumer", private: true, type: "module" }, null, 2)}\n`);
  console.log(`[packages] installing ${tarballs.length} tarball(s) into ${consumer}`);
  npm(["install", "--no-audit", "--no-fund", "--ignore-scripts", ...tarballs.map((entry) => entry.tarball)], { cwd: consumer });

  for (const { dir, manifest } of tarballs) {
    const installed = JSON.parse(readFileSync(join(consumer, "node_modules", ...manifest.name.split("/"), "package.json"), "utf8"));
    if (installed.private) fail(`${manifest.name} was packed with "private": true, so npm would refuse to publish the tarball`);
    const smoke = join(dir, "test", "smoke.mjs");
    if (!existsSync(smoke)) fail(`${manifest.name} has no test/smoke.mjs`);
    const target = join(consumer, `${fileSlug(manifest.name)}.smoke.mjs`);
    cpSync(smoke, target);
    console.log(`[packages] running ${manifest.name} smoke test as an installed dependency`);
    run(process.execPath, [target], { cwd: consumer });
  }
  console.log(`[packages] verified ${tarballs.map((entry) => entry.manifest.name).join(", ")}`);
}

const [command, ...rest] = process.argv.slice(2);
const outIndex = rest.indexOf("--out");
const outArg = outIndex >= 0 ? rest[outIndex + 1] : undefined;
if (outIndex >= 0 && !outArg) fail("--out needs a directory");
const names = rest.filter((_, index) => outIndex < 0 || (index !== outIndex && index !== outIndex + 1));
const packages = listPackages(names);

if (command === "typecheck") {
  typecheck(packages);
} else if (command === "pack" || command === "verify") {
  const outRoot = outArg ? resolve(outArg) : mkdtempSync(join(tmpdir(), "bridge-packages-"));
  // Packing empties <out>/<package name> first, and the Bridge build stamp hashes src/.
  if (isInsideOrSame(repoRoot, outRoot)) fail(`--out must be outside the repository (${repoRoot}): ${outRoot}`);
  mkdirSync(outRoot, { recursive: true });
  if (command === "pack") pack(packages, outRoot);
  else verify(packages, outRoot);
  if (command === "verify" && !outArg) {
    try {
      rmSync(outRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch (error) {
      console.warn(`[packages] could not remove ${outRoot}: ${error.message}`);
    }
  } else {
    console.log(`[packages] output: ${outRoot}`);
  }
} else {
  fail("usage: node scripts/packages.mjs <typecheck|pack|verify> [--out <dir>] [package ...]");
}
