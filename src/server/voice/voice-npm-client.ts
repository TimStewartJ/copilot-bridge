// Fetches pinned npm packages with the machine's own npm client. A host that blocks the public
// registry in favour of an internal feed only serves tarballs to a real npm client, and npm
// already carries the registry, credentials, proxy and CA settings that installed Bridge
// itself. The installer checks every tarball against a pinned integrity afterwards.
import { execFile } from "node:child_process";
import { mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { resolveNpmInvocation, type NpmInvocation } from "../platform.js";

export type RunCommand = (command: string, args: string[], options: {
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
}) => Promise<void>;

export class CommandError extends Error {
  constructor(
    message: string,
    readonly details: { exitCode?: number; missing: boolean; timedOut: boolean; stderr: string },
  ) {
    super(message);
    this.name = "CommandError";
  }
}

export const runCommand: RunCommand = (command, args, options) => new Promise((resolve, reject) => {
  execFile(command, args, {
    cwd: options.cwd,
    env: options.env,
    timeout: options.timeoutMs,
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  }, (error, _stdout, stderr) => {
    if (!error) {
      resolve();
      return;
    }
    const failure = error as NodeJS.ErrnoException & { killed?: boolean };
    reject(new CommandError(failure.message, {
      ...(typeof failure.code === "number" ? { exitCode: failure.code } : {}),
      missing: failure.code === "ENOENT",
      timedOut: failure.killed === true,
      stderr: String(stderr ?? ""),
    }));
  });
});

export interface NpmClient {
  /** Fetches the published tarball for `name@version` into an emptied `directory` and returns its path. */
  pack(spec: string, directory: string): Promise<string>;
}

const NPM_PACK_TIMEOUT_MS = 20 * 60_000;
const NPM_LOG_NOISE = /^(errno|syscall|a complete log of this run|log files?:)/i;

/** Boils npm's stderr down to its error code and first explanatory line. */
export function describeNpmError(error: unknown): string {
  if (!(error instanceof CommandError)) return error instanceof Error ? error.message : String(error);
  if (error.details.missing) return "npm was not found beside Node or on PATH";
  if (error.details.timedOut) return "npm timed out";
  const lines = error.details.stderr
    .split(/\r?\n/)
    .map((line) => line.replace(/^npm\s+(?:error|ERR!)\s*/i, "").trim())
    .filter((line) => line && !NPM_LOG_NOISE.test(line));
  const code = lines.find((line) => /^code\s+\S+/i.test(line))?.replace(/^code\s+/i, "");
  const detail = lines.find((line) => !/^code\s+\S+/i.test(line));
  const summary = [code, detail].filter(Boolean).join(": ") || `npm exited with code ${error.details.exitCode ?? "unknown"}`;
  return summary.slice(0, 300);
}

export function createNpmClient(options: {
  env?: NodeJS.ProcessEnv;
  /** Defaults to the npm beside Node or on PATH; undefined means this host has none. */
  invocation?: NpmInvocation | undefined;
  run?: RunCommand;
} = {}): NpmClient {
  const env = options.env ?? process.env;
  const invocation = "invocation" in options ? options.invocation : resolveNpmInvocation({ env });
  const run = options.run ?? runCommand;
  return {
    async pack(spec, directory) {
      if (!invocation) throw new CommandError("npm not found", { missing: true, timedOut: false, stderr: "" });
      await rm(directory, { recursive: true, force: true });
      await mkdir(directory, { recursive: true });
      // For a registry spec npm writes the published tarball unchanged, so its bytes still
      // match the pinned integrity. It runs in the target directory because older npm
      // versions have no --pack-destination.
      await run(
        invocation.command,
        [...invocation.args, "pack", spec, "--ignore-scripts", "--loglevel=error", "--no-update-notifier"],
        { cwd: directory, env, timeoutMs: NPM_PACK_TIMEOUT_MS },
      );
      const tarballs = (await readdir(directory)).filter((name) => name.endsWith(".tgz"));
      if (tarballs.length !== 1) throw new Error("npm pack did not produce a tarball");
      return join(directory, tarballs[0]!);
    },
  };
}
