import { describe, expect, it } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveDefaultReleaseDataDir, resolveRuntimePaths } from "../runtime-paths.js";

describe("runtime paths", () => {
  it("derives isolated defaults when demo mode is enabled without explicit paths", () => {
    const paths = resolveRuntimePaths({ BRIDGE_DEMO_MODE: "true" });

    expect(paths.demoMode).toBe(true);
    expect(paths.dataDir).toMatch(/demo-data$/);
    expect(paths.docsDir).toBe(join(paths.dataDir, "docs"));
    expect(paths.copilotHome).toBe(join(paths.dataDir, ".copilot"));
    expect(paths.workspaceDir).toBe(join(paths.dataDir, "workspace"));
    expect(paths.env.BRIDGE_DATA_DIR).toBe(paths.dataDir);
    expect(paths.env.BRIDGE_DOCS_DIR).toBe(paths.docsDir);
    expect(paths.env.COPILOT_HOME).toBe(paths.copilotHome);
    expect(paths.env.BRIDGE_DEMO_MODE).toBe("true");
  });

  it("keeps existing explicit overrides intact", () => {
    const dataDir = join(tmpdir(), "demo-data");
    const docsDir = join(tmpdir(), "demo-docs");
    const copilotHome = join(tmpdir(), "demo-copilot");
    const paths = resolveRuntimePaths({
      BRIDGE_DEMO_MODE: "true",
      BRIDGE_DATA_DIR: dataDir,
      BRIDGE_DOCS_DIR: docsDir,
      COPILOT_HOME: copilotHome,
    });

    expect(paths.dataDir).toBe(dataDir);
    expect(paths.docsDir).toBe(docsDir);
    expect(paths.copilotHome).toBe(copilotHome);
    expect(paths.workspaceDir).toBe(join(paths.dataDir, "workspace"));
  });

  it("uses durable per-user defaults in release mode", () => {
    const localAppData = join(tmpdir(), "local-app-data");
    const paths = resolveRuntimePaths({
      BRIDGE_DISTRIBUTION_MODE: "release",
      LOCALAPPDATA: localAppData,
    });

    expect(paths.distributionMode).toBe("release");
    expect(paths.demoMode).toBe(false);
    expect(paths.dataDir).toBe(resolveDefaultReleaseDataDir({ LOCALAPPDATA: localAppData }));
    expect(paths.docsDir).toBe(join(paths.dataDir, "docs"));
    expect(paths.copilotHome).toBe(join(paths.dataDir, ".copilot"));
    expect(paths.workspaceDir).toBeUndefined();
    expect(paths.env.BRIDGE_DISTRIBUTION_MODE).toBe("release");
    expect(paths.env.BRIDGE_DATA_DIR).toBe(paths.dataDir);
    expect(paths.env.BRIDGE_DOCS_DIR).toBe(paths.docsDir);
    expect(paths.env.COPILOT_HOME).toBe(paths.copilotHome);
  });

  it("treats blank optional path env vars as unset", () => {
    const localAppData = join(tmpdir(), "blank-release-env");
    const paths = resolveRuntimePaths({
      BRIDGE_DISTRIBUTION_MODE: "release",
      LOCALAPPDATA: localAppData,
      BRIDGE_DATA_DIR: "",
      BRIDGE_DOCS_DIR: " ",
      COPILOT_HOME: "",
    });

    expect(paths.dataDir).toBe(resolveDefaultReleaseDataDir({ LOCALAPPDATA: localAppData }));
    expect(paths.docsDir).toBe(join(paths.dataDir, "docs"));
    expect(paths.copilotHome).toBe(join(paths.dataDir, ".copilot"));
  });
});
