import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..");

function readSdkClientSource(format: "esm" | "cjs"): string {
  const filePath = format === "esm"
    ? join(REPO_ROOT, "node_modules", "@github", "copilot-sdk", "dist", "client.js")
    : join(REPO_ROOT, "node_modules", "@github", "copilot-sdk", "dist", "cjs", "client.js");
  return readFileSync(filePath, "utf8");
}

describe("Copilot SDK native session contracts", () => {
  it("forwards Bridge eager-loading metadata on create and resume", () => {
    for (const format of ["esm", "cjs"] as const) {
      const source = readSdkClientSource(format);
      const deferForwardingCount = source.match(/defer: tool\.defer/g)?.length ?? 0;
      expect(deferForwardingCount, format).toBeGreaterThanOrEqual(2);
    }
  });

  it("forwards the official GitHub MCP tool config on create and resume", () => {
    for (const format of ["esm", "cjs"] as const) {
      const source = readSdkClientSource(format);
      const optionsForwardingCount = source.match(/githubMcpToolConfig: config\.githubMcpToolConfig/g)?.length ?? 0;
      expect(optionsForwardingCount, format).toBeGreaterThanOrEqual(2);
    }
  });

  it("forwards the structured ask_user variant on create and resume", () => {
    for (const format of ["esm", "cjs"] as const) {
      const source = readSdkClientSource(format);
      const variantForwardingCount = source.match(/askUserVariant: config\.askUserVariant/g)?.length ?? 0;
      expect(variantForwardingCount, format).toBe(2);
    }
  });
});
