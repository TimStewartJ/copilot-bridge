import { describe, expect, it } from "vitest";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { resolveDefaultReleaseDataDir, resolveDefaultWorkspaceDir, resolveRuntimePaths } from "../runtime-paths.js";
import { createValidationCommandEnv } from "../validation-command-env.js";

describe("runtime paths", () => {
  it("derives development defaults with a per-user workspace outside the checkout", () => {
    const paths = resolveRuntimePaths({}, { distributionMode: "development" });

    expect(paths.dataDir).toMatch(/data$/);
    expect(paths.docsDir).toBe(join(paths.dataDir, "docs"));
    expect(paths.docsSnapshotsDir).toBe(join(paths.dataDir, "backups", "docs", "snapshots"));
    expect(paths.copilotHome).toBeUndefined();
    expect(paths.workspaceDir).toBe(resolveDefaultWorkspaceDir({}));
    expect(paths.workspaceDir?.startsWith(paths.dataDir)).toBe(false);
    expect(paths.env.BRIDGE_WORKSPACE_DIR).toBe(paths.workspaceDir);
    expect(paths.env.BRIDGE_DATA_DIR).toBe(paths.dataDir);
    expect(paths.env.BRIDGE_DOCS_DIR).toBe(paths.docsDir);
    expect(paths.env.BRIDGE_DOCS_SNAPSHOTS_DIR).toBe(paths.docsSnapshotsDir);
    expect(paths.env).toMatchObject({
      GIT_PAGER: "cat",
      PAGER: "cat",
      TERM: "dumb",
      GIT_TERMINAL_PROMPT: "0",
    });
  });

  it("keeps existing explicit overrides intact", () => {
    const dataDir = join(tmpdir(), "bridge-data");
    const docsDir = join(tmpdir(), "bridge-docs");
    const docsSnapshotsDir = join(tmpdir(), "bridge-docs-snapshots");
    const copilotHome = join(tmpdir(), "bridge-copilot");
    const workspaceDir = join(tmpdir(), "bridge-workspace");
    const paths = resolveRuntimePaths({
      BRIDGE_DATA_DIR: dataDir,
      BRIDGE_DOCS_DIR: docsDir,
      BRIDGE_DOCS_SNAPSHOTS_DIR: docsSnapshotsDir,
      COPILOT_HOME: copilotHome,
    }, {
      workspaceDir,
    });

    expect(paths.dataDir).toBe(dataDir);
    expect(paths.docsDir).toBe(docsDir);
    expect(paths.docsSnapshotsDir).toBe(docsSnapshotsDir);
    expect(paths.copilotHome).toBe(copilotHome);
    expect(paths.workspaceDir).toBe(workspaceDir);
  });

  it("uses durable per-user defaults in release mode", () => {
    const localAppData = join(tmpdir(), "local-app-data");
    const paths = resolveRuntimePaths({
      BRIDGE_DISTRIBUTION_MODE: "release",
      LOCALAPPDATA: localAppData,
    });

    expect(paths.distributionMode).toBe("release");
    expect(paths.dataDir).toBe(resolveDefaultReleaseDataDir({ LOCALAPPDATA: localAppData }));
    expect(paths.docsDir).toBe(join(paths.dataDir, "docs"));
    expect(paths.docsSnapshotsDir).toBe(join(paths.dataDir, "backups", "docs", "snapshots"));
    expect(paths.copilotHome).toBe(join(paths.dataDir, ".copilot"));
    expect(paths.workspaceDir).toBe(resolveDefaultWorkspaceDir({ LOCALAPPDATA: localAppData }));
    expect(paths.env.BRIDGE_DISTRIBUTION_MODE).toBe("release");
    expect(paths.env.BRIDGE_DATA_DIR).toBe(paths.dataDir);
    expect(paths.env.BRIDGE_DOCS_DIR).toBe(paths.docsDir);
    expect(paths.env.BRIDGE_DOCS_SNAPSHOTS_DIR).toBe(paths.docsSnapshotsDir);
    expect(paths.env.COPILOT_HOME).toBe(paths.copilotHome);
  });

  it("places the default workspace beside the per-user data directory on every platform", () => {
    const localAppData = join(tmpdir(), "local-app-data");
    const xdgDataHome = join(tmpdir(), "xdg-data");

    expect(resolveDefaultWorkspaceDir({ LOCALAPPDATA: localAppData }, "win32"))
      .toBe(join(localAppData, "CopilotBridge", "workspace"));
    expect(resolveDefaultWorkspaceDir({ XDG_DATA_HOME: xdgDataHome }, "linux"))
      .toBe(join(xdgDataHome, "CopilotBridge", "workspace"));
    expect(resolveDefaultWorkspaceDir({}, "darwin"))
      .toBe(join(dirname(resolveDefaultReleaseDataDir({}, "darwin")), "workspace"));
  });

  it("honours an explicit workspace from the environment", () => {
    const workspaceDir = join(tmpdir(), "env-workspace");
    const paths = resolveRuntimePaths({ BRIDGE_WORKSPACE_DIR: ` ${workspaceDir} ` }, { distributionMode: "development" });

    expect(paths.workspaceDir).toBe(workspaceDir);
    expect(paths.env.BRIDGE_WORKSPACE_DIR).toBe(workspaceDir);
  });

  it("treats blank optional path env vars as unset", () => {
    const localAppData = join(tmpdir(), "blank-release-env");
    const paths = resolveRuntimePaths({
      BRIDGE_DISTRIBUTION_MODE: "release",
      LOCALAPPDATA: localAppData,
      BRIDGE_DATA_DIR: "",
      BRIDGE_DOCS_DIR: " ",
      BRIDGE_DOCS_SNAPSHOTS_DIR: "",
      COPILOT_HOME: "",
    });

    expect(paths.dataDir).toBe(resolveDefaultReleaseDataDir({ LOCALAPPDATA: localAppData }));
    expect(paths.docsDir).toBe(join(paths.dataDir, "docs"));
    expect(paths.docsSnapshotsDir).toBe(join(paths.dataDir, "backups", "docs", "snapshots"));
    expect(paths.copilotHome).toBe(join(paths.dataDir, ".copilot"));
  });

  it("isolates validation data and Copilot home paths", () => {
    const hostDataDir = join(tmpdir(), "host-data");
    const validation = createValidationCommandEnv({ BRIDGE_DATA_DIR: hostDataDir });
    try {
      expect(validation.env.BRIDGE_DATA_DIR).toBe(validation.dataDir);
      expect(validation.env.COPILOT_HOME).toBe(validation.copilotHome);
      expect(validation.dataDir).not.toBe(hostDataDir);
    } finally {
      validation.cleanup();
    }
  });
});
