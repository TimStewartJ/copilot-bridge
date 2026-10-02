import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// src/packages/* holds code that is published on its own (see src/packages/README.md). A package
// is only publishable while it depends on nothing else in this repository, and the Bridge can only
// swap the in-tree copy for the published one while it uses nothing but the package's entry
// point. This test walks the real files so neither rule can erode silently.

const SRC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PACKAGES_DIR = join(SRC_DIR, "packages");
// Bridge modules that may reach past a package's entry point, and why.
const INTERNAL_IMPORTS_ALLOWED: Record<string, string> = {
  "server/process-host-worker.ts":
    "worker entry kept for processes that started before the host moved; it must start the package's worker module itself",
};
const IMPORT_SPECIFIER = /(?:^|\n)\s*(?:import|export)\s+(?:[^"';]*?\s+from\s+)?["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)|\brequire\(\s*["']([^"']+)["']\s*\)/g;

interface InTreePackage {
  dir: string;
  manifest: {
    name: string;
    type?: string;
    license?: string;
    engines?: { node?: string };
    exports?: Record<string, unknown>;
    files?: string[];
    sideEffects?: boolean;
    dependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
  };
}

const packages: InTreePackage[] = readdirSync(PACKAGES_DIR, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => join(PACKAGES_DIR, entry.name))
  .map((dir) => ({ dir, manifest: JSON.parse(readFileSync(join(dir, "package.json"), "utf-8")) as InTreePackage["manifest"] }));

function listFiles(dir: string, extensions: readonly string[]): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : listFiles(path, extensions);
    return extensions.some((extension) => entry.name.endsWith(extension)) ? [path] : [];
  });
}

function importsOf(file: string): string[] {
  const source = readFileSync(file, "utf-8");
  return [...source.matchAll(IMPORT_SPECIFIER)].map((match) => (match[1] ?? match[2] ?? match[3])!);
}

const display = (file: string): string => relative(SRC_DIR, file).split(sep).join("/");
const isInside = (dir: string, file: string): boolean => file === dir || file.startsWith(dir + sep);
const packageNameOf = (specifier: string): string =>
  specifier.split("/").slice(0, specifier.startsWith("@") ? 2 : 1).join("/");

describe("in-tree packages", () => {
  it("finds the packages", () => {
    expect(packages.map((entry) => entry.manifest.name).sort()).toEqual(["smart-turn-js", "spawn-offthread", "voice-agent-text"]);
  });

  it.each(packages)("$manifest.name is laid out the way scripts/packages.mjs publishes it", ({ dir, manifest }) => {
    for (const file of ["README.md", "LICENSE", "tsconfig.json", "tsconfig.build.json", "src/index.ts", "test/smoke.mjs"]) {
      expect(existsSync(join(dir, file)), `${manifest.name} needs ${file}`).toBe(true);
    }
    expect(manifest).toMatchObject({
      type: "module",
      license: "MIT",
      files: ["dist"],
      sideEffects: false,
      exports: { ".": { types: "./dist/index.d.ts", default: "./dist/index.js" } },
    });
  });

  it.each(packages)("$manifest.name depends on nothing else in this repository", ({ dir, manifest }) => {
    const declared = new Set([...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.peerDependencies ?? {})]);
    const violations: string[] = [];
    const check = (file: string, allowed: (specifier: string) => boolean, root: string): void => {
      for (const specifier of importsOf(file)) {
        const ok = specifier.startsWith(".") ? isInside(root, resolve(dirname(file), specifier)) : allowed(specifier);
        if (!ok) violations.push(`${display(file)} imports ${specifier}`);
      }
    };
    // A package without engines.node runs anywhere, so its source may not use Node's modules.
    const sourceMayUseNode = manifest.engines?.node !== undefined;
    for (const file of listFiles(join(dir, "src"), [".ts"])) {
      check(file, (specifier) => (specifier.startsWith("node:") ? sourceMayUseNode : declared.has(packageNameOf(specifier))), join(dir, "src"));
    }
    for (const file of listFiles(join(dir, "test"), [".ts"])) {
      check(file, (specifier) => specifier.startsWith("node:") || specifier === "vitest" || declared.has(packageNameOf(specifier)), dir);
    }
    // The smoke test runs in a scratch project that has only the packed tarballs installed.
    check(join(dir, "test", "smoke.mjs"), (specifier) => specifier.startsWith("node:") || specifier === manifest.name, join(dir, "test"));

    expect(violations, "A package must stay publishable by itself: keep Bridge code out of it and declare what it uses.").toEqual([]);
  });

  it("is used by the Bridge only through each package's entry point", () => {
    const violations: string[] = [];
    const unusedExceptions = new Set(Object.keys(INTERNAL_IMPORTS_ALLOWED));
    for (const file of listFiles(SRC_DIR, [".ts", ".tsx"])) {
      if (isInside(PACKAGES_DIR, file)) continue;
      for (const specifier of importsOf(file)) {
        if (!specifier.startsWith(".")) continue;
        const target = resolve(dirname(file), specifier);
        const owner = packages.find((entry) => isInside(entry.dir, target));
        if (!owner || target === join(owner.dir, "src", "index.js")) continue;
        if (unusedExceptions.delete(display(file))) continue;
        violations.push(`${display(file)} imports ${specifier}`);
      }
    }
    expect(violations, "Import an in-tree package as src/packages/<name>/src/index.js, the same surface its published build has.").toEqual([]);
    expect([...unusedExceptions], "exceptions that no longer apply must be removed").toEqual([]);
  });
});
