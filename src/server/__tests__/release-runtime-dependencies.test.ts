import { readdirSync, readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { SRC_DIR, readImports } from "./runtime-import-graph.js";

// A release package installs only the packages listed in scripts/release-runtime-dependencies.json.
// The server once started importing `ws` without it being listed: every packaged server crashed at
// startup, and only the release workflows, which run after a push, start a package to notice. The
// launcher starts the server and job runner by path, and the server starts its workers by path, so
// this checks every non-test module except the client, which Vite bundles.

const REPO_ROOT = resolve(SRC_DIR, "..");

// Modules that may import packages a release does not install, and why they never run from one.
const SOURCE_CHECKOUT_ONLY: Record<string, string> = {
  "server/preview-smoke.ts": "npm run preview:smoke checks a staging preview from a source checkout",
  "server/xplat-test-audit.ts": "npm run test:xplat-audit audits the tests of a source checkout",
};

const readJson = (path: string): unknown => JSON.parse(readFileSync(join(REPO_ROOT, path), "utf-8"));
const releaseDependencies = readJson("scripts/release-runtime-dependencies.json") as string[];
const declaredDependencies = (readJson("package.json") as { dependencies: Record<string, string> }).dependencies;

function shippedModules(): string[] {
  return readdirSync(SRC_DIR, { recursive: true, encoding: "utf-8" })
    .map((file) => file.split("\\").join("/"))
    .filter((file) => /\.tsx?$/.test(file) && !/\.(test|d)\.tsx?$/.test(file))
    .filter((file) => !/^(client|integration|test-support)\/|(^|\/)(__tests__|test)\//.test(file));
}

function packageNameOf(specifier: string): string | null {
  if (specifier.startsWith(".") || specifier.startsWith("node:")) return null;
  const parts = specifier.split("/");
  if (builtinModules.includes(parts[0]!)) return null;
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
}

describe("release runtime dependencies", () => {
  it("installs every package the launcher, server and workers import", () => {
    const imported = new Set<string>();
    const missing = new Map<string, string>();
    const unusedExceptions = new Set(Object.keys(SOURCE_CHECKOUT_ONLY));
    for (const file of shippedModules()) {
      for (const { specifier } of readImports(readFileSync(join(SRC_DIR, file), "utf-8"))) {
        const name = packageNameOf(specifier);
        if (!name) continue;
        imported.add(name);
        if (releaseDependencies.includes(name)) continue;
        if (file in SOURCE_CHECKOUT_ONLY) unusedExceptions.delete(file);
        else if (!missing.has(name)) missing.set(name, file);
      }
    }
    expect(imported, "the scan should reach the server's package imports").toContain("express");
    expect(
      [...missing].map(([name, file]) => `${name} (imported by ${file})`),
      "Add these packages to scripts/release-runtime-dependencies.json, or a release package will not have them.",
    ).toEqual([]);
    expect([...unusedExceptions], "exceptions that no longer apply must be removed").toEqual([]);
  });

  it("lists only packages declared as dependencies", () => {
    const undeclared = releaseDependencies.filter((name) => !(name in declaredDependencies));
    expect(undeclared, "release packages install the versions package.json declares under dependencies").toEqual([]);
  });
});
