import { describe, expect, it, vi } from "vitest";
import { makeTestDir } from "./helpers.js";

describe("deploy check contract", () => {
  it("does not run coverage during interactive deploy validation", async () => {
    const { DEPLOY_CHECK_STEPS } = await import("../deploy-check.js");
    const commands = DEPLOY_CHECK_STEPS.map((step) => step.join(" "));

    expect(commands).toEqual([
      "npm run check:pr",
    ]);
    expect(commands).not.toContain("npm run test:coverage");
    expect(commands).not.toContain("npm run preview:smoke");
  });

  it("keeps production deploy checks separate from staging-only smoke", async () => {
    const { DEPLOY_CHECK_STEPS } = await import("../deploy-check.js");
    const { DEPLOY_GATE, STAGING_DEPLOY_GATE } = await import("../validation-pipeline.js");
    const deployCommands = DEPLOY_CHECK_STEPS.map((step) => step.join(" "));

    expect(DEPLOY_GATE.steps.map((step) => step.command)).toEqual(["npm run check:deploy"]);
    expect(deployCommands).toEqual(["npm run check:pr"]);
    expect(STAGING_DEPLOY_GATE.steps.map((step) => step.command)).toEqual([
      "npm run check:pr",
      "npm run preview:smoke",
    ]);
  });

  it("falls back to captured output when a failed step log disappears", async () => {
    vi.resetModules();
    const logDir = makeTestDir("deploy-check-missing-log");
    vi.stubEnv("BRIDGE_VALIDATION_LOG_DIR", logDir);
    vi.doMock("node:fs", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:fs")>();
      return {
        ...actual,
        statSync: (path: Parameters<typeof actual.statSync>[0], ...args: unknown[]) => {
          if (String(path).includes("-deploy-check-")) {
            const error = new Error("mocked missing log") as NodeJS.ErrnoException;
            error.code = "ENOENT";
            throw error;
          }
          return actual.statSync(path, ...(args as []));
        },
      };
    });
    const { runDeployChecks } = await import("../deploy-check.js");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const script = [
      "process.stdout.write('real smoke failure marker\\n');",
      "process.exit(7);",
    ].join("");
    const steps = [[process.execPath, "-e", script]] as any;

    try {
      await expect(runDeployChecks(steps)).rejects.toThrow("failed");
      const stderr = errorSpy.mock.calls.map((args) => args.join(" ")).join("\n");
      expect(stderr).toContain("unable to read log tail");
      expect(stderr).toContain("real smoke failure marker");
    } finally {
      errorSpy.mockRestore();
      vi.doUnmock("node:fs");
      vi.resetModules();
      vi.unstubAllEnvs();
    }
  });
});
