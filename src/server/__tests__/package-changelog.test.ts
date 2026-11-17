import ts from "typescript";
import { describe, expect, it } from "vitest";
import { changelogVerdict, isRealChange, latestReleaseTag } from "../../../scripts/package-changelog.mjs";

const SOURCE = "/** Adds. */\nexport function add(a: number, b: number): number {\n  return a + b;\n}\n";

describe("package changelog check", () => {
  it.each([
    { name: "a comment-only edit", path: "src/a.ts", after: `// Explains add.\n${SOURCE.replace("Adds.", "Adds two numbers.")}`, real: false },
    { name: "a whitespace-only edit", path: "src/a.ts", after: SOURCE.replace("return a + b;", "return a  +  b ;"), real: false },
    { name: "a code edit", path: "src/a.ts", after: SOURCE.replace("a + b", "a - b"), real: true },
    { name: "an added @ts-expect-error", path: "src/a.ts", after: SOURCE.replace("  return", "  // @ts-expect-error\n  return"), real: true },
    { name: "an added file", path: "src/a.ts", before: null, after: SOURCE, real: true },
    { name: "a deleted file", path: "src/a.ts", after: null, real: true },
    { name: "whitespace in a file that is not TypeScript", path: "src/data.json", before: '{"a":1}', after: '{ "a": 1 }', real: true },
  ])("$name is a real change: $real", ({ path, before, after, real }) => {
    expect(isRealChange(ts, path, before === null ? undefined : (before ?? SOURCE), after ?? undefined)).toBe(real);
  });

  it.each([
    { name: "nothing changed", changed: [], changelog: "# Changelog\n\n## 0.1.1\n\nFirst.\n", version: "0.1.1", ok: true },
    { name: "a line under Unreleased", changelog: "# Changelog\n\n## Unreleased\n\n- Fix add.\n\n## 0.1.1\n\nFirst.\n", version: "0.1.1", ok: true },
    { name: "an empty Unreleased section", changelog: "# Changelog\n\n## Unreleased\n\n## 0.1.1\n\nFirst.\n", version: "0.1.1", ok: false },
    { name: "no changelog", changelog: undefined, version: "0.1.1", ok: false },
    { name: "a section for the coming release", changelog: "# Changelog\n\n## 0.2.0 (unreleased)\n\n- Fix add.\n\n## 0.1.1\n\nFirst.\n", version: "0.2.0", ok: true },
    { name: "only the released version's section", changelog: "# Changelog\n\n## 0.1.1\n\nFirst.\n", version: "0.1.1", ok: false },
  ])("a package with $name passes: $ok", ({ changed, changelog, version, ok }) => {
    const changedFiles = changed ?? ["src/packages/kit/src/a.ts"];
    expect(changelogVerdict({ changedFiles, changelog, version, baselineVersion: "0.1.1" }).ok).toBe(ok);
  });

  it("takes the highest released version of the package as its baseline", () => {
    const tags = ["kit-v0.9.0", "kit-v0.10.0", "kit-v1.0.0-beta", "kit-extra-v2.0.0", "preview-0.1.0"];
    expect(latestReleaseTag(tags, "kit")).toEqual({ tag: "kit-v0.10.0", version: "0.10.0" });
    expect(latestReleaseTag(tags, "other")).toBeUndefined();
  });
});
