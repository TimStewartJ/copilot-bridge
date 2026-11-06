import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { auditPublicRepo, findLockfileHosts, normalizeLockfile } from "../public-repo-audit.js";

const MIRROR = "https://mirror.example.com/feed/npm/registry";

const lockfile = (scopedHost: string, plainHost: string) =>
  `${JSON.stringify(
    {
      packages: {
        "": { name: "app" },
        "node_modules/@scope/tool": { resolved: `${scopedHost}/@scope/tool/-/tool-1.0.0.tgz`, integrity: "sha512-aaa" },
        "node_modules/plain": { resolved: `${plainHost}/plain/-/plain-2.0.0.tgz`, integrity: "sha512-bbb" },
        "node_modules/linked": { resolved: "src/packages/linked", link: true },
      },
    },
    null,
    2,
  )}\n`;

describe("public repo audit", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function audit(files: Record<string, string>): string[] {
    const root = mkdtempSync(join(tmpdir(), "bridge-public-audit-"));
    roots.push(root);
    for (const [file, content] of Object.entries(files)) {
      const path = join(root, ...file.split("/"));
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, content);
    }
    return auditPublicRepo(root);
  }

  it("moves lockfile entries from a mirror to the public registry without touching their hashes", () => {
    const mirrored = lockfile(MIRROR, "https://registry.npmjs.org");
    expect(findLockfileHosts(mirrored)).toEqual(["mirror.example.com"]);
    expect(audit({ "package-lock.json": mirrored })[0]).toContain("npm run lockfile:public");

    const fixed = normalizeLockfile(mirrored);
    expect(fixed).toBe(lockfile("https://registry.npmjs.org", "https://registry.npmjs.org"));
    expect(audit({ "package-lock.json": fixed })).toEqual([]);
  });

  it("names the file and line of an Azure DevOps org that is not an example", () => {
    const realOrg = ["real", "company"].join("");
    expect(
      audit({
        "src/a.test.ts": ["// fine", `const url = "https://dev.azure.com/${realOrg}/One/_git/repo";`].join("\n"),
        "README.md": `See https://${realOrg}.visualstudio.com/One.`,
      }),
    ).toEqual([
      `README.md:1: Azure DevOps org "${realOrg}" is not an example org. Use a made-up org in tests and docs.`,
      `src/a.test.ts:2: Azure DevOps org "${realOrg}" is not an example org. Use a made-up org in tests and docs.`,
    ]);
  });

  it.each([
    "https://dev.azure.com/exampleorg/One",
    "https://acme.visualstudio.com/One",
    "https://dev.azure.com/${org}/One",
    "https://global.rel.tunnels.api.visualstudio.com/auth",
  ])("accepts %s", (url) => {
    expect(audit({ "src/a.ts": `const url = "${url}";` })).toEqual([]);
  });
});
