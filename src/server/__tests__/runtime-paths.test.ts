import { describe, expect, it } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveDefaultReleaseDataDir, resolveRuntimePaths } from "../runtime-paths.js";

describe("runtime paths", () => {
  it("derives development defaults without an implicit workspace", () => {
    const paths = resolveRuntimePaths({});

    expect(paths.dataDir).toMatch(/data$/);
    expect(paths.docsDir).toBe(join(paths.dataDir, "docs"));
    expect(paths.docsSnapshotsDir).toBe(join(paths.dataDir, "backups", "docs", "snapshots"));
    expect(paths.copilotHome).toBeUndefined();
    expect(paths.workspaceDir).toBeUndefined();
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
    expect(paths.workspaceDir).toBeUndefined();
    expect(paths.env.BRIDGE_DISTRIBUTION_MODE).toBe("release");
    expect(paths.env.BRIDGE_DATA_DIR).toBe(paths.dataDir);
    expect(paths.env.BRIDGE_DOCS_DIR).toBe(paths.docsDir);
    expect(paths.env.BRIDGE_DOCS_SNAPSHOTS_DIR).toBe(paths.docsSnapshotsDir);
    expect(paths.env.COPILOT_HOME).toBe(paths.copilotHome);
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
});
