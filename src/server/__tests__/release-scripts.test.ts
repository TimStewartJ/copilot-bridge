import { readFileSync } from "node:fs";
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
    expect(allowlist).toContain("@github/copilot-sdk");
    expect(allowlist).not.toContain("@github/copilot");
  });

  it("includes and starts the SDK's platform-specific native runtime", () => {
    const packageScript = readFileSync(join(process.cwd(), "scripts", "package-release.ps1"), "utf-8");
    const smokeScript = readFileSync(join(process.cwd(), "scripts", "test-release-package.ps1"), "utf-8");

    expect(packageScript).toContain("npm install --omit=dev --include=optional --no-audit --no-fund");
    expect(smokeScript).toContain("@github\\copilot-sdk-win32-x64");
    expect(smokeScript).toContain("copilot-runtime.exe");
    expect(smokeScript).toContain("runtime.node");
    expect(smokeScript).toContain("copilot-sdk\\index.js");
    expect(smokeScript).toContain("buildCopilotClientOptions");
    expect(smokeScript).toContain("await client.start(); await client.ping();");
    expect(smokeScript).toContain("await client.stop();");
    expect(smokeScript).not.toContain("@github\\copilot-win32-x64");
  });

  it("packages the native SDK without patch-package compatibility shims", () => {
    const packageScript = readFileSync(join(process.cwd(), "scripts", "package-release.ps1"), "utf-8");

    expect(packageScript).not.toContain("patch-package");
    expect(packageScript).not.toContain('(Join-Path $repoRoot "patches")');
    expect(packageScript).not.toContain("copilot-cli-loader.js");
    expect(packageScript).not.toContain("copilot-cli-wrapper.js");
  });

  it("checks SDK-nested platform packages before hoisted dependencies", () => {
    const smokeScript = readFileSync(join(process.cwd(), "scripts", "test-release-package.ps1"), "utf-8");
    const nested = smokeScript.indexOf('"@github\\copilot-sdk\\node_modules\\@github\\copilot-sdk-win32-x64"');
    const hoisted = smokeScript.indexOf('"@github\\copilot-sdk-win32-x64"');

    expect(nested).toBeGreaterThan(-1);
    expect(hoisted).toBeGreaterThan(nested);
    expect(smokeScript.slice(nested, hoisted)).toContain(
      'if (-not (Test-Path (Join-Path $copilotPlatformRoot "package.json")))',
    );
  });

  it("runs CI for pushed staging branches", () => {
    const ciWorkflow = readFileSync(join(process.cwd(), ".github", "workflows", "ci.yml"), "utf-8");
    expect(ciWorkflow).toContain('- "staging/**"');
  });
});
