import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("release scripts", () => {
  // The native Bridge-tools MCP server imports @modelcontextprotocol/sdk as a value at
  // startup. It is NOT a transitive dependency of any other allowlisted package, so it must
  // be installed explicitly — otherwise the packaged server crashes on boot with
  // ERR_MODULE_NOT_FOUND and never becomes healthy. Guarding this prevents a silent
  // reintroduction of that release-only crash.
  it("bundles every runtime dependency the packaged server imports at startup", () => {
    const packageScript = readFileSync(join(process.cwd(), "scripts", "package-release.ps1"), "utf-8");

    const allowlistMatch = packageScript.match(/\$runtimeDependencyNames\s*=\s*@\(([\s\S]*?)\)/);
    expect(allowlistMatch, "package-release.ps1 must define $runtimeDependencyNames").not.toBeNull();
    const allowlist = [...allowlistMatch![1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);

    const mcpServerSource = readFileSync(
      join(process.cwd(), "src", "server", "agent-tools-mcp", "server.ts"),
      "utf-8",
    );
    const responseTransportSource = readFileSync(
      join(process.cwd(), "src", "server", "response-transport.ts"),
      "utf-8",
    );
    expect(mcpServerSource).toMatch(/from\s+"@modelcontextprotocol\/sdk\//);
    expect(allowlist).toContain("@modelcontextprotocol/sdk");
    expect(responseTransportSource).toMatch(/from\s+"compression"/);
    expect(allowlist).toContain("compression");
  });

  it("includes and validates the platform-specific Copilot CLI runtime", () => {
    const packageScript = readFileSync(join(process.cwd(), "scripts", "package-release.ps1"), "utf-8");
    const smokeScript = readFileSync(join(process.cwd(), "scripts", "test-release-package.ps1"), "utf-8");

    expect(packageScript).toContain("npm install --omit=dev --include=optional --no-audit --no-fund");
    expect(packageScript).not.toContain(
      'Remove-PathIfExists (Join-Path $AppDir "node_modules\\@github\\copilot-win32-x64")',
    );
    expect(smokeScript).toContain("@github\\copilot-win32-x64");
    expect(smokeScript).toContain("copilot.exe");
    expect(smokeScript).toContain("sdk\\index.js");
    expect(smokeScript).toContain("import('@github/copilot-win32-x64/sdk')");
  });

  it("applies the Bridge SDK patch in packaged installs", () => {
    const packageScript = readFileSync(join(process.cwd(), "scripts", "package-release.ps1"), "utf-8");

    expect(packageScript).toContain('$runtimePackageJson.dependencies["patch-package"]');
    expect(packageScript).toContain('postinstall = "patch-package --error-on-fail"');
    expect(packageScript).toContain('(Join-Path $repoRoot "patches")');
  });

  it("uses GitHub actions backed by Node 24 or newer", () => {
    const workflowsDir = join(process.cwd(), ".github", "workflows");
    const workflowSource = readdirSync(workflowsDir)
      .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
      .map((name) => readFileSync(join(workflowsDir, name), "utf-8"))
      .join("\n");

    expect(workflowSource).not.toMatch(/actions\/checkout@v[1-4]\b/);
    expect(workflowSource).not.toMatch(/actions\/setup-node@v[1-4]\b/);
    expect(workflowSource).not.toMatch(/actions\/upload-artifact@v[1-5]\b/);
    expect(workflowSource).not.toMatch(/actions\/download-artifact@v[1-6]\b/);
  });

  it("runs CI for pushed staging branches", () => {
    const ciWorkflow = readFileSync(join(process.cwd(), ".github", "workflows", "ci.yml"), "utf-8");
    expect(ciWorkflow).toContain('- "staging/**"');
  });
});
