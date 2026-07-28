// Guards the module-graph split that keeps Vitest import time down.
//
// Vitest re-evaluates each test file's module graph in isolation, so a single
// stray import in a widely-shared module multiplies across the whole suite.
// Before this split, `__tests__/helpers.ts` reached `api-router.ts` and pulled
// ~180 modules (~2 MB) into all 123 of its importers even though only 40 of
// them mount HTTP routes.

import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const testsDir = dirname(fileURLToPath(import.meta.url));
const serverDir = resolve(testsDir, "..");
const repoRoot = resolve(serverDir, "..", "..");

/**
 * Matches `import`/`export ... from "..."` declarations plus bare side-effect imports.
 *
 * This is a deliberately conservative source scan rather than a real parse: it errs
 * toward reporting *more* modules than the runtime graph actually contains, so a
 * passing assertion is always a true negative. Known approximation: top-level
 * `await import(...)` is not followed, which is fine here because lazy imports are
 * exactly what this guard wants to encourage.
 */
const IMPORT_DECLARATION_RE = /(?:^|\n)\s*(?:import|export)\s+(?:([^'";]*?)\s+from\s+)?["']([^"']+)["']/g;

/** True for `import type {...}` and for `import { type A, type B }` — neither is emitted. */
function isTypeOnlyClause(clause: string | undefined): boolean {
  if (clause === undefined) return false;
  const trimmed = clause.trim();
  if (trimmed.startsWith("type ")) return true;
  const named = /^\{([\s\S]*)\}$/.exec(trimmed);
  if (!named) return false;
  const specifiers = named[1].split(",").map((entry) => entry.trim()).filter(Boolean);
  return specifiers.length > 0 && specifiers.every((entry) => entry.startsWith("type "));
}

function resolveRelativeSpecifier(specifier: string, fromFile: string): string | null {
  if (!specifier.startsWith(".")) return null;
  const base = resolve(dirname(fromFile), specifier);
  const withoutJs = base.endsWith(".js") ? `${base.slice(0, -3)}.ts` : base;
  for (const candidate of [withoutJs, `${base}.ts`, `${base}.tsx`, join(base, "index.ts")]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/** Local (first-party) modules reachable through value imports from `entry`. */
function moduleGraph(entry: string): Set<string> {
  const seen = new Set<string>();
  const pending = [entry];
  while (pending.length > 0) {
    const file = pending.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(IMPORT_DECLARATION_RE)) {
      if (isTypeOnlyClause(match[1])) continue;
      const resolved = resolveRelativeSpecifier(match[2], file);
      if (resolved && !seen.has(resolved)) pending.push(resolved);
    }
  }
  return seen;
}

function graphOf(relativePath: string): Set<string> {
  return moduleGraph(resolve(repoRoot, relativePath));
}

function contains(graph: Set<string>, relativePath: string): boolean {
  return graph.has(resolve(repoRoot, relativePath));
}

function relativeNames(graph: Set<string>): string[] {
  return [...graph].map((file) => relative(repoRoot, file)).sort();
}

describe("test fixture module graph", () => {
  it("keeps shared test helpers off the API router graph", () => {
    const graph = graphOf("src/server/__tests__/helpers.ts");

    expect(contains(graph, "src/server/api-router.ts")).toBe(false);
    expect(contains(graph, "src/server/session-manager.ts")).toBe(false);
    expect(contains(graph, "src/server/app-context-factory.ts")).toBe(false);
    expect(relativeNames(graph).length).toBeLessThanOrEqual(30);
  });

  it("still wires the full app graph for the heavy fixture", () => {
    const graph = graphOf("src/server/__tests__/test-app.ts");

    expect(contains(graph, "src/server/api-router.ts")).toBe(true);
  });

  it("keeps the shutdown coordinator off the app-context factory graph", () => {
    const graph = graphOf("src/server/shutdown-coordinator.ts");

    expect(contains(graph, "src/server/app-context-factory.ts")).toBe(false);
    expect(contains(graph, "src/server/agent-tools-mcp/index.ts")).toBe(false);
    expect(relativeNames(graph).length).toBeLessThanOrEqual(10);
  });

  it("keeps the API router off the MCP tool registry graph", () => {
    const graph = graphOf("src/server/api-router.ts");

    expect(contains(graph, "src/server/app-context-factory.ts")).toBe(false);
    expect(contains(graph, "src/server/agent-tools-mcp/index.ts")).toBe(false);
    expect(contains(graph, "src/server/agent-tools-mcp/register.ts")).toBe(false);
    expect(contains(graph, "src/server/staging-tools.ts")).toBe(false);
  });

  it("scans imports conservatively", () => {
    // Guards the scanner itself: a false "value import" would silently weaken
    // every assertion above into a no-op.
    expect(isTypeOnlyClause("type { AppContext }")).toBe(true);
    expect(isTypeOnlyClause("{ type PendingInteractionSnapshot }")).toBe(true);
    expect(isTypeOnlyClause("{\n  type A,\n  type B,\n}")).toBe(true);
    expect(isTypeOnlyClause("{ type A, createThing }")).toBe(false);
    expect(isTypeOnlyClause("express")).toBe(false);
    expect(isTypeOnlyClause("defaultExport, { named }")).toBe(false);
    expect(isTypeOnlyClause(undefined)).toBe(false);
  });
});
