import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { resolveBridgeControlRoot } from "../control-root.js";

const REPO_ROOT = resolveBridgeControlRoot(join(import.meta.dirname, "..", "..", ".."));

function readSdkClientSource(format: "esm" | "cjs"): string {
  const filePath = format === "esm"
    ? join(REPO_ROOT, "node_modules", "@github", "copilot-sdk", "dist", "client.js")
    : join(REPO_ROOT, "node_modules", "@github", "copilot-sdk", "dist", "cjs", "client.js");
  return readFileSync(filePath, "utf8");
}

describe("patched Copilot SDK tool serializer", () => {
  it("forwards Bridge eager-loading metadata on create and resume", () => {
    for (const format of ["esm", "cjs"] as const) {
      const source = readSdkClientSource(format);
      const deferForwardingCount = source.match(/defer: tool\.defer/g)?.length ?? 0;
      expect(deferForwardingCount, format).toBeGreaterThanOrEqual(2);
    }
  });

  it("keeps forwarding Bridge GitHub MCP tool options", () => {
    for (const format of ["esm", "cjs"] as const) {
      const source = readSdkClientSource(format);
      const optionsForwardingCount = source.match(/githubMcpToolOptions: config\.githubMcpToolOptions/g)?.length ?? 0;
      expect(optionsForwardingCount, format).toBeGreaterThanOrEqual(2);
    }
  });
});
