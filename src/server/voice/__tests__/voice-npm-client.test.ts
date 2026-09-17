import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { makeTestDir } from "../../__tests__/helpers.js";
import { testExecutablePath } from "../../__tests__/test-paths.js";
import { CommandError, createNpmClient, describeNpmError, type RunCommand } from "../voice-npm-client.js";

const invocation = { command: testExecutablePath("node"), args: [testExecutablePath("npm-cli.js")] };

describe("npm client", () => {
  it("packs a registry spec into an emptied directory with the host's npm settings", async () => {
    const directory = join(makeTestDir("voice-npm-pack"), "scratch");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "stale.tgz"), "old");
    const run = vi.fn<RunCommand>(async (_command, _args, options) => {
      writeFileSync(join(options.cwd, "example-1.2.3.tgz"), "tarball");
    });
    const npm = createNpmClient({ invocation, env: { NPM_CONFIG_REGISTRY: "https://feed.example/npm/" }, run });
    const tarball = await npm.pack("example@1.2.3", directory);
    expect(basename(tarball)).toBe("example-1.2.3.tgz");
    expect(readFileSync(tarball, "utf8")).toBe("tarball");
    expect(run).toHaveBeenCalledWith(
      invocation.command,
      [...invocation.args, "pack", "example@1.2.3", "--ignore-scripts", "--loglevel=error", "--no-update-notifier"],
      expect.objectContaining({ cwd: directory, env: { NPM_CONFIG_REGISTRY: "https://feed.example/npm/" } }),
    );
  });

  it("fails when npm leaves no tarball behind", async () => {
    const npm = createNpmClient({ invocation, run: async () => undefined });
    await expect(npm.pack("example@1.2.3", join(makeTestDir("voice-npm-empty"), "scratch"))).rejects.toThrow("npm pack did not produce a tarball");
  });

  it("reports a host without npm the same way as an npm that cannot be started", async () => {
    const run = vi.fn<RunCommand>();
    const npm = createNpmClient({ invocation: undefined, run });
    const failure = await npm.pack("example@1.2.3", join(makeTestDir("voice-npm-missing"), "scratch")).catch((error: unknown) => error);
    expect(describeNpmError(failure)).toBe("npm was not found beside Node or on PATH");
    expect(run).not.toHaveBeenCalled();
  });

  it("summarizes npm failures", () => {
    const failure = (stderr: string, details: Partial<CommandError["details"]> = {}) =>
      new CommandError("Command failed", { exitCode: 1, missing: false, timedOut: false, stderr, ...details });
    expect(describeNpmError(failure([
      "npm error code E404",
      "npm error 404 Not Found - GET https://feed.example/npm/example - not_found",
      "npm error 404",
      "npm error A complete log of this run can be found in: C:\\logs\\debug-0.log",
    ].join("\r\n")))).toBe("E404: 404 Not Found - GET https://feed.example/npm/example - not_found");
    expect(describeNpmError(failure("npm ERR! code ENOTFOUND\nnpm ERR! errno ENOTFOUND\nnpm ERR! network request failed"))).toBe("ENOTFOUND: network request failed");
    expect(describeNpmError(failure("", { missing: true }))).toBe("npm was not found beside Node or on PATH");
    expect(describeNpmError(failure("", { timedOut: true }))).toBe("npm timed out");
    expect(describeNpmError(failure(""))).toBe("npm exited with code 1");
    expect(describeNpmError(new Error("plain"))).toBe("plain");
  });
});
