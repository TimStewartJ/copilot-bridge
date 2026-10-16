import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const serverRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (file: string) => readFileSync(resolve(serverRoot, file), "utf8");

describe("API composition boundary", () => {
  it("keeps conversation service construction out of route registration", () => {
    // Production and preview must own the same service lifetime, before either registers routes.
    expect(read("api-router.ts")).not.toMatch(/new\s+(?:HelmService|VoiceGateway)\b|(?:createVoiceRuntime|createServerShutdownCoordinator)\s*\(/);
    expect(read("api-services.ts")).toMatch(/new HelmService\(/);
    expect(read("api-services.ts")).toMatch(/new VoiceGateway\(/);
  });

  it("uses the same composition in production, preview and test applications", () => {
    for (const file of ["index.ts", "staging-preview-server.ts", join("__tests__", "test-app.ts")]) {
      expect(read(file), file).toContain("createApiServices");
    }
  });

  it("registers catalog routes through their domain module", () => {
    const router = read("api-router.ts");
    expect(router).toContain("registerCatalogRoutes(router");
    expect(router).not.toMatch(/router\.(?:get|post|patch|delete)\("\/(?:skills|mcp-servers|tags)(?:\/|")/);
  });
});
