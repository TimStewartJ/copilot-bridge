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
    expect(mcpServerSource).toMatch(/from\s+"@modelcontextprotocol\/sdk\//);
    expect(allowlist).toContain("@modelcontextprotocol/sdk");
  });
});
