#!/usr/bin/env node
// In-tree packages (src/packages/*) are published on their own. This script checks and builds
// them the way a consumer gets them. It never writes under src/: the Bridge build stamp hashes
// that tree, so build output goes to a directory outside the repository.
//
//   typecheck               type-check every package with its own tsconfig, not the Bridge's
//   pack   [--out <dir>]    compile every package and write an installable tarball for each
//   verify [--out <dir>]    pack, install the tarballs into a scratch project, run each smoke test
//   release-check <package> [--dry-run]
//                           say whether the package's version can be released from this checkout
//
// Without --out, pack and verify work in a new temporary directory. pack prints it, because the
// tarballs are its result. verify removes it once everything passed and leaves it in place after a
// failure. Add package names or folder names after the command to limit it to those packages.
//
// A tarball from pack is what a release publishes (see src/packages/README.md). Its package.json
// is the folder's without "private", which stays in the folder so npm refuses to publish the
// source, and with the commit it was built from as gitHead.
//
// release-check is the first step of the Publish Package workflow, and works the same on a
// developer's machine. It asks npm which versions exist and origin whether the release tag does.
// With --dry-run it reports a version that is already released instead of failing on it, so the
// workflow can be tried out between releases.

import { spawnSync } from "node:child_process";
import {
  appendFileSync,
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
const REGISTRY = "https://registry.npmjs.org";
// A pre-release would need a dist-tag other than "latest", which the release workflow does not set.
const RELEASE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

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

function compareReleaseVersions(left, right) {
  const [a, b] = [left, right].map((version) => version.split(".").map(Number));
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/** What a package's changelog still lacks for a release of this version. */
function changelogProblems(dir, version) {
  const file = join(dir, "CHANGELOG.md");
  if (!existsSync(file)) return ["it has no CHANGELOG.md"];
  const lines = readFileSync(file, "utf8").split(/\r?\n/);
  const isHeading = (line, title) => line === `## ${title}` || line.startsWith(`## ${title} `);
  const problems = [];
  if (!lines.some((line) => isHeading(line, version))) problems.push(`CHANGELOG.md has no "## ${version}" section`);
  const unreleased = lines.findIndex((line) => isHeading(line, "Unreleased"));
  if (unreleased >= 0) {
    const next = lines.findIndex((line, index) => index > unreleased && line.startsWith("## "));
    const entries = lines.slice(unreleased + 1, next < 0 ? lines.length : next).filter((line) => line.trim() !== "");
    if (entries.length > 0) problems.push(`CHANGELOG.md still lists ${entries.length} line(s) under "## Unreleased"; move them to "## ${version}"`);
  }
  return problems;
}

/** The versions of a package that are public on npm, or undefined when npm does not know the package. */
async function publishedVersions(name) {
  let response;
  try {
    response = await fetch(`${REGISTRY}/${name.replace("/", "%2f")}`, {
      headers: { accept: "application/vnd.npm.install-v1+json" },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    return fail(`could not ask npm about ${name}: ${error.message}`);
  }
  if (response.status === 404) return undefined;
  if (!response.ok) return fail(`npm answered ${response.status} when asked about ${name}`);
  return Object.keys((await response.json()).versions ?? {});
}

function remoteTagExists(tag) {
  const result = spawnSync("git", ["ls-remote", "--tags", "origin", `refs/tags/${tag}`], { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.error || result.status !== 0) fail(`could not ask origin whether the tag ${tag} exists: ${(result.error?.message ?? result.stderr).trim()}`);
  return result.stdout.trim() !== "";
}

async function releaseCheck({ dir, manifest }, dryRun) {
  const { name, version } = manifest;
  const folder = basename(dir);
  const tag = `${folder}-v${version}`;
  // Wrong whatever npm holds: these fail a dry run too.
  const problems = changelogProblems(dir, version);
  if (!RELEASE_VERSION.test(version)) problems.push(`its version ${version} is not of the form 1.2.3`);
  if (!sourceCommit(dir)) problems.push("its folder has local changes or is not in a git checkout, and a release is built from a commit");
  // True between releases: a dry run reports these and goes on.
  const released = [];
  const published = await publishedVersions(name);
  const highest = published?.filter((candidate) => RELEASE_VERSION.test(candidate)).sort(compareReleaseVersions).at(-1);
  if (!published) {
    released.push("npm does not know the package; its first version is published from the owner's machine (see src/packages/README.md)");
  } else if (published.includes(version)) {
    released.push(`${version} is already on npm; set the next version in its package.json`);
  } else if (highest && RELEASE_VERSION.test(version) && compareReleaseVersions(version, highest) < 0) {
    released.push(`${version} is lower than ${highest}, which is on npm`);
  }
  if (remoteTagExists(tag)) released.push(`the tag ${tag} exists, so ${version} was released before`);

  if (dryRun) for (const note of released) console.log(`[packages] dry run, ${name}: ${note}`);
  const blocking = dryRun ? problems : [...problems, ...released];
  if (blocking.length > 0) fail(`${name}@${version} cannot be released:\n${blocking.map((problem) => `  - ${problem}`).join("\n")}`);

  console.log(`[packages] ${name}@${version} ${dryRun ? "passed the checks of a dry run" : `can be released as ${tag}`} (highest version on npm: ${highest ?? "none"})`);
  // In a GitHub Actions job, hand the result to the following steps.
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `folder=${folder}\nname=${name}\nversion=${version}\ntag=${tag}\n`);
  }
}

const [command, ...rest] = process.argv.slice(2);
const outIndex = rest.indexOf("--out");
const outArg = outIndex >= 0 ? rest[outIndex + 1] : undefined;
if (outIndex >= 0 && !outArg) fail("--out needs a directory");
const dryRun = rest.includes("--dry-run");
if (dryRun && command !== "release-check") fail("--dry-run only applies to release-check");
const names = rest.filter((arg, index) => arg !== "--dry-run" && (outIndex < 0 || (index !== outIndex && index !== outIndex + 1)));
const packages = listPackages(names);

if (command === "typecheck") {
  typecheck(packages);
} else if (command === "release-check") {
  if (names.length !== 1 || packages.length !== 1) fail("release-check needs exactly one package: its name or its folder name");
  await releaseCheck(packages[0], dryRun);
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
  fail("usage: node scripts/packages.mjs <typecheck|pack|verify> [--out <dir>] [package ...]\n       node scripts/packages.mjs release-check <package> [--dry-run]");
}
