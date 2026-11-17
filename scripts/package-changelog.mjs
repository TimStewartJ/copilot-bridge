// changelog-check: a package whose src/ changed since its last release must say so in CHANGELOG.md.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, join } from "node:path";

export const RELEASE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function compareReleaseVersions(left, right) {
  const [a, b] = [left, right].map((version) => version.split(".").map(Number));
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/** Non-blank lines of the `## <title>` or `## <title> <suffix>` section; undefined if none. */
export function changelogSection(text, title) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => line === `## ${title}` || line.startsWith(`## ${title} `));
  if (start < 0) return undefined;
  const next = lines.findIndex((line, index) => index > start && line.startsWith("## "));
  return lines.slice(start + 1, next < 0 ? lines.length : next).filter((line) => line.trim() !== "");
}

/** The latest release of a package among the repository's tags: the highest `<folder>-v<x.y.z>`. */
export function latestReleaseTag(tags, folder) {
  const prefix = `${folder}-v`;
  const versions = tags
    .filter((tag) => tag.startsWith(prefix) && RELEASE_VERSION.test(tag.slice(prefix.length)))
    .map((tag) => tag.slice(prefix.length))
    .sort(compareReleaseVersions);
  const version = versions.at(-1);
  return version === undefined ? undefined : { tag: `${prefix}${version}`, version };
}

// The printer drops these comments, but they change what the compiler or a bundler does.
const DIRECTIVE_COMMENT = /^\s*\/\/\/\s*<reference\b|@ts-(?:ignore|expect-error|nocheck|check)\b|[#@]__PURE__/;

/** The source lines that carry a TypeScript or bundler directive. */
export function directiveComments(source) {
  return source.split(/\r?\n/).filter((line) => DIRECTIVE_COMMENT.test(line)).map((line) => line.trim());
}

/** Whether two versions differ beyond TS comments and whitespace; undefined means no file. */
export function isRealChange(ts, path, before, after) {
  if (before === undefined || after === undefined) return before !== after;
  if (!/\.tsx?$/.test(path)) return !Buffer.from(before).equals(Buffer.from(after));
  const [oldText, newText] = [before, after].map((content) => Buffer.from(content).toString("utf8"));
  const printer = ts.createPrinter({ removeComments: true });
  const kind = path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const print = (text) => printer.printFile(ts.createSourceFile(path, text, ts.ScriptTarget.Latest, false, kind));
  if (print(oldText) !== print(newText)) return true;
  return directiveComments(oldText).join("\n") !== directiveComments(newText).join("\n");
}

/** Whether a changelog (undefined if missing) covers source changes since `baselineVersion`. */
export function changelogVerdict({ changedFiles, changelog, version, baselineVersion }) {
  if (changedFiles.length === 0) return { ok: true, detail: `no source changes since ${baselineVersion}` };
  const text = changelog ?? "";
  if ((changelogSection(text, "Unreleased") ?? []).length > 0) return { ok: true, detail: `${changedFiles.length} changed file(s), listed under "## Unreleased"` };
  const preparing = RELEASE_VERSION.test(version) && compareReleaseVersions(version, baselineVersion) > 0;
  if (preparing && (changelogSection(text, version) ?? []).length > 0) {
    return { ok: true, detail: `${changedFiles.length} changed file(s), listed under "## ${version}" for the coming release` };
  }
  const where = preparing ? `"## Unreleased" or "## ${version}"` : `"## Unreleased" at the top`;
  return {
    ok: false,
    detail: `src/ changed since ${baselineVersion} (${changedFiles.join(", ")}) but CHANGELOG.md has no line about it; add one under ${where}`,
  };
}

function git(repoRoot, args) {
  return spawnSync("git", args, { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
}

function gitText(repoRoot, args) {
  const result = git(repoRoot, args);
  if (result.error || result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${(result.error?.message ?? result.stderr.toString("utf8")).trim()}`);
  }
  return result.stdout.toString("utf8");
}

const nulSeparated = (output) => output.split("\0").filter(Boolean);

/** Paths (from repoRoot) under a package's src/ that differ from the tag, untracked included. */
function changedSourceFiles(repoRoot, dir, tag) {
  const source = ["src", "packages", basename(dir), "src"].join("/");
  const diffed = nulSeparated(gitText(repoRoot, ["diff", "--name-only", "-z", "--no-renames", "--relative", tag, "--", source]));
  const untracked = nulSeparated(gitText(repoRoot, ["ls-files", "--others", "--exclude-standard", "-z", "--", source]));
  return [...new Set([...diffed, ...untracked])].sort();
}

function contentAtTag(repoRoot, tag, path) {
  const result = git(repoRoot, ["show", `${tag}:./${path}`]);
  return result.status === 0 ? result.stdout : undefined;
}

function contentNow(repoRoot, path) {
  const file = join(repoRoot, ...path.split("/"));
  return existsSync(file) ? readFileSync(file) : undefined;
}

/** Checks each package, printing one line per package; false when any failed. */
export function changelogCheck(repoRoot, packages, log = console.log) {
  // A release slot has no .git but sits inside the production checkout, so git would answer for it.
  const top = git(repoRoot, ["rev-parse", "--show-toplevel"]);
  const topLevel = top.error || top.status !== 0 ? "" : top.stdout.toString("utf8").trim();
  if (!topLevel || realpathSync(topLevel) !== realpathSync(repoRoot)) {
    log("[packages] changelog-check skipped: not a git checkout");
    return true;
  }
  const tags = gitText(repoRoot, ["tag", "-l"]).split(/\r?\n/).filter(Boolean);
  if (tags.length === 0) {
    log("[packages] changelog-check failed: this checkout has no git tags, so it cannot tell what each package last released. Fetch them with `git fetch --tags`.");
    return false;
  }
  const ts = createRequire(join(repoRoot, "package.json"))("typescript");
  let ok = true;
  for (const { dir, manifest } of packages) {
    const release = latestReleaseTag(tags, basename(dir));
    if (!release) {
      log(`[packages] changelog-check ${manifest.name}: skipped, never released (no ${basename(dir)}-v<version> tag)`);
      continue;
    }
    const differing = changedSourceFiles(repoRoot, dir, release.tag);
    const changedFiles = differing.filter((path) =>
      isRealChange(ts, path, contentAtTag(repoRoot, release.tag, path), contentNow(repoRoot, path)),
    );
    const commentOnly = differing.length - changedFiles.length;
    const changelogFile = join(dir, "CHANGELOG.md");
    const verdict = changelogVerdict({
      changedFiles,
      changelog: existsSync(changelogFile) ? readFileSync(changelogFile, "utf8") : undefined,
      version: manifest.version,
      baselineVersion: release.version,
    });
    const ignored = commentOnly > 0 ? ` (${commentOnly} file(s) differ only in comments or whitespace)` : "";
    log(`[packages] changelog-check ${manifest.name}: ${verdict.ok ? "ok" : "failing"}, ${verdict.detail}${ignored}`);
    if (!verdict.ok) ok = false;
  }
  return ok;
}
