import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Reads the imports of the Bridge's own TypeScript sources, for structural guards that must see
// every module a runtime entry point can load.

export const SERVER_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const SRC_DIR = resolve(SERVER_DIR, "..");

const IMPORT_STATEMENT = /(?:^|\n)\s*(import|export)\s+(type\s+)?([^"';]*?)\s*from\s*["']([^"']+)["']/g;
const SIDE_EFFECT_IMPORT = /(?:^|\n)\s*import\s*["']([^"']+)["']/g;
const DYNAMIC_IMPORT = /\bimport\(\s*["']([^"']+)["']\s*\)/g;
const REQUIRE_CALL = /\brequire\(\s*["']([^"']+)["']\s*\)/g;

export interface ModuleImport {
  specifier: string;
  /** Names imported as values. "*" means the whole module (namespace, default, dynamic, require). */
  valueNames: string[];
}

function valueNamesOf(clause: string): string[] {
  const trimmed = clause.trim();
  if (!trimmed.startsWith("{")) return ["*"];
  return trimmed
    .replace(/^\{|\}$/g, "")
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part && !part.startsWith("type "))
    .map((part) => part.split(/\s+as\s+/)[0]!.trim());
}

export function readImports(source: string): ModuleImport[] {
  const imports: ModuleImport[] = [];
  for (const match of source.matchAll(IMPORT_STATEMENT)) {
    if (match[2]) continue; // `import type` / `export type` are erased at build time
    const valueNames = valueNamesOf(match[3] ?? "");
    if (valueNames.length > 0) imports.push({ specifier: match[4]!, valueNames });
  }
  for (const pattern of [SIDE_EFFECT_IMPORT, DYNAMIC_IMPORT, REQUIRE_CALL]) {
    for (const match of source.matchAll(pattern)) imports.push({ specifier: match[1]!, valueNames: ["*"] });
  }
  return imports;
}

function resolveModule(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;
  const base = resolve(dirname(fromFile), specifier).replace(/\.js$/, "");
  for (const candidate of [`${base}.ts`, `${base}.tsx`, join(base, "index.ts")]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** Every source module reachable from `entryPoints` through value imports, with the imports each one makes. */
export function walkImportGraph(entryPoints: string[]): Map<string, ModuleImport[]> {
  const graph = new Map<string, ModuleImport[]>();
  const pending = [...entryPoints];
  while (pending.length > 0) {
    const file = pending.pop()!;
    if (graph.has(file)) continue;
    const imports = readImports(readFileSync(file, "utf-8"));
    graph.set(file, imports);
    for (const { specifier } of imports) {
      const target = resolveModule(file, specifier);
      if (target && !graph.has(target)) pending.push(target);
    }
  }
  return graph;
}

export const display = (file: string): string => relative(SRC_DIR, file).split("\\").join("/");
