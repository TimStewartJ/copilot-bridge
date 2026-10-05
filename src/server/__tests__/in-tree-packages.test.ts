import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

// src/packages/* holds code that is published on its own (see src/packages/README.md). A package
// is only publishable while it depends on nothing else in this repository, and the Bridge can only
// swap the in-tree copy for the published one while it uses nothing but the package's entry
// point. This test walks the real files so neither rule can erode silently. It also reads the
// workflow that releases a package, which may ask npm for a token and so has rules of its own.

const SRC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PACKAGES_DIR = join(SRC_DIR, "packages");
const PUBLISH_WORKFLOW = join(SRC_DIR, "..", ".github", "workflows", "publish-package.yml");
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
    version: string;
    private?: boolean;
    repository?: { type?: string; url?: string; directory?: string };
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
    expect(packages.map((entry) => entry.manifest.name).sort()).toEqual(["@timstewartj/smart-turn", "spawn-offthread", "voice-agent-text"]);
  });

  it.each(packages)("$manifest.name is laid out the way scripts/packages.mjs publishes it", ({ dir, manifest }) => {
    for (const file of ["README.md", "LICENSE", "CHANGELOG.md", "tsconfig.json", "tsconfig.build.json", "src/index.ts", "test/smoke.mjs"]) {
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

  it.each(packages)("$manifest.name is released as a built tarball, never as its folder", ({ dir, manifest }) => {
    // The folder holds source, not the build, so npm has to refuse to publish it.
    // scripts/packages.mjs leaves the flag out of the manifest it packs.
    expect(manifest.private, `keep "private": true in the package.json of ${manifest.name}`).toBe(true);
    // When a GitHub workflow publishes, npm compares this with the repository letter for letter.
    expect(manifest.repository).toEqual({
      type: "git",
      url: "git+https://github.com/TimStewartJ/copilot-bridge.git",
      directory: `src/packages/${basename(dir)}`,
    });
    const heading = `## ${manifest.version}`;
    const changelog = readFileSync(join(dir, "CHANGELOG.md"), "utf-8").split(/\r?\n/);
    expect(
      changelog.some((line) => line === heading || line.startsWith(`${heading} `)),
      `CHANGELOG.md of ${manifest.name} needs a "${heading}" section`,
    ).toBe(true);
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

interface WorkflowJob {
  permissions?: Record<string, string>;
  steps: { uses?: string; run?: string }[];
}

describe("the workflow that releases an in-tree package", () => {
  const workflow = parseYaml(readFileSync(PUBLISH_WORKFLOW, "utf-8")) as {
    on: { workflow_dispatch: { inputs: { package: { options: string[] } } } };
    permissions: Record<string, string>;
    jobs: Record<string, WorkflowJob>;
  };
  const commandsOf = (job: WorkflowJob): string[] => job.steps.map((step) => step.run ?? "");

  it("offers every package", () => {
    expect([...workflow.on.workflow_dispatch.inputs.package.options].sort()).toEqual(packages.map((entry) => basename(entry.dir)).sort());
  });

  it("runs only when someone starts it, and publishes the version in one place", () => {
    // Nobody approves a version between this workflow and npm, and a published version is
    // permanent. So a release must take someone starting it, never a push or a tag.
    expect(Object.keys(workflow.on)).toEqual(["workflow_dispatch"]);
    const commands = Object.values(workflow.jobs).flatMap(commandsOf);
    expect(commands.filter((command) => /\bnpm publish\b/.test(command))).toHaveLength(1);
    expect(commands.filter((command) => /\bnpm stage\b/.test(command))).toEqual([]);
  });

  it("hands npm the tarball as a path it cannot take for a GitHub repository", () => {
    // npm reads "release/<file>.tgz" as the repository "release/<file>.tgz" on GitHub and tries to
    // fetch it. A path that starts with "./" is a file.
    const published = Object.values(workflow.jobs).flatMap(commandsOf).flatMap((command) => command.match(/\bnpm publish \S+/g) ?? []);
    expect(published).toEqual(['npm publish "./release/$FILE"']);
  });

  it("lets only a job that runs no code from the repository ask npm for a token", () => {
    // Whatever runs in that job can publish a tarball of its own making. It gets the tarball the
    // build job made, and installs nothing but the npm that hands it over.
    expect(workflow.permissions).toEqual({});
    const withToken = Object.entries(workflow.jobs).filter(([, job]) => job.permissions?.["id-token"] !== undefined);
    expect(withToken.map(([id, job]) => [id, job.permissions])).toEqual([["publish", { "id-token": "write" }]]);
    const publish = withToken[0]![1];
    expect(publish.steps.filter((step) => step.uses?.startsWith("actions/checkout"))).toEqual([]);
    const installs = commandsOf(publish).flatMap((command) => command.match(/\bnpm (?:ci|i|install)\b.*/g) ?? []);
    expect(installs).toEqual(['npm install --global "npm@$NPM_VERSION"']);
    expect(commandsOf(publish).filter((command) => /\bnpm run\b|\bnpx\b|\bnode scripts\b/.test(command))).toEqual([]);
  });

  it("releases from master only", () => {
    // The trusted publisher on npm names the workflow file, not a branch: without this step a
    // changed copy of the workflow on any branch could publish.
    const first = workflow.jobs.build!.steps[0] as { if?: string; run?: string };
    expect(first.if).toBe("github.ref != 'refs/heads/master'");
    expect(first.run).toContain("exit 1");
    expect(workflow.jobs.publish).toMatchObject({ needs: "build" });
  });
});
