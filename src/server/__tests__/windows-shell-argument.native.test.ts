import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";

import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { windowsShellInvocation } from "../platform.js";
import { getProcessHost, resetProcessHostForTests } from "../process-host.js";
import { makeTestDir } from "./helpers.js";

// The quoting exists for cmd.exe and a `.cmd` launcher, and only those can say whether it holds.
const windows = process.platform === "win32";

/** What npm writes beside a globally installed package's command (cmd-shim), for a script `echo-args.js`. */
const NPM_LAUNCHER = [
  "@ECHO off",
  "GOTO start",
  ":find_dp0",
  "SET dp0=%~dp0",
  "EXIT /b",
  ":start",
  "SETLOCAL",
  "CALL :find_dp0",
  "",
  "IF EXIST \"%dp0%\\node.exe\" (",
  "  SET \"_prog=%dp0%\\node.exe\"",
  ") ELSE (",
  "  SET \"_prog=node\"",
  "  SET PATHEXT=%PATHEXT:;.JS;=;%",
  ")",
  "",
  "endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & \"%_prog%\"  \"%dp0%\\echo-args.js\" %*",
  "",
].join("\r\n");

/** The shortest launcher that passes its arguments on. */
const PLAIN_LAUNCHER = "@node \"%~dp0echo-args.js\" %*\r\n";

const ARGUMENTS = [
  "https://duck.com/?q=rust%20book&ia=web",
  "https://example.com/a|b<c>d^e",
  "a&b",
  "a&&b||c",
  "%PATH%",
  "%OS%",
  "%CMDCMDLINE:~-1%&echo x>canary.txt&rem ",
  "%CMDCMDLINE:~-1% & echo x>canary.txt & rem ",
  "\"&echo x>canary.txt&rem ",
  "\" & echo x>canary.txt & \"",
  "say \"hi\"",
  "\"",
  "\"\"",
  "a\\\"b",
  "a\\\\\"b",
  "{\"key\": \"a b\", \"n\": 100%}",
  "100%",
  "%%",
  "%1",
  "%*",
  "%~dp0",
  "!PATH!",
  "a^",
  "^^",
  "a b",
  " leading and trailing ",
  "",
  "C:\\dir\\",
  "a b\\",
  "\\\\server\\share\\",
  "a\\b",
  "\uFF02",
  "\u00E9\u00FC",
  "\u{1F600}",
  "-x",
  "--flag=value",
  "/c",
  "@e12",
  "(a)",
  "a;b,c=d",
  "'single'",
  "a\tb",
  "*.txt",
  "~",
];

describe.runIf(windows)("an argument quoted for the Windows command shell", () => {
  let directory = "";
  // Not the launchers' folder: they are then found through PATH alone, as agent-browser is, and
  // a launcher misled about its own folder does not find the script beside it.
  let workingDirectory = "";
  let env: NodeJS.ProcessEnv = {};

  // Per test: the shared helpers remove a test's folders when it ends.
  beforeEach(() => {
    directory = makeTestDir("windows-shell-argument");
    workingDirectory = makeTestDir("windows-shell-argument-cwd");
    writeFileSync(
      path.join(directory, "echo-args.js"),
      "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n",
    );
    writeFileSync(path.join(directory, "plain-launcher.cmd"), PLAIN_LAUNCHER);
    writeFileSync(path.join(directory, "npm-launcher.cmd"), NPM_LAUNCHER);
    // Windows names the variable `Path`, and a copy of the environment can hold it under more than
    // one spelling, of which a new process gets the first in sorted order. Exactly one is passed on.
    const pathNames = Object.keys(process.env).filter((name) => name.toUpperCase() === "PATH").sort();
    const others = Object.entries(process.env).filter(([name]) => !pathNames.includes(name));
    env = {
      ...Object.fromEntries(others),
      PATH: [directory, process.env[pathNames[0] ?? "PATH"] ?? ""].join(path.delimiter),
    };
  });

  afterAll(async () => {
    await resetProcessHostForTests();
  });

  async function received(launcher: string, args: string[]): Promise<string[]> {
    const invocation = windowsShellInvocation(launcher, args);
    if (!invocation) throw new Error("no way to pass these arguments");
    const { stdout } = await getProcessHost().execFile(invocation.file, invocation.args, {
      encoding: "utf-8",
      windowsVerbatimArguments: invocation.verbatim,
      env,
      // Something an unquoted argument started would write here.
      cwd: workingDirectory,
      timeout: 30_000,
    });
    return JSON.parse(stdout) as string[];
  }

  it.each(["plain-launcher", "npm-launcher"])("reaches the program behind %s unchanged, whatever it contains", async (launcher) => {
    expect(await received(launcher, ARGUMENTS)).toEqual(ARGUMENTS);
    expect(existsSync(path.join(workingDirectory, "canary.txt"))).toBe(false);
  });

  it.each(["plain-launcher", "npm-launcher"])("reaches the program behind %s unchanged when it is the only argument", async (launcher) => {
    for (const argument of ARGUMENTS) {
      expect(await received(launcher, [argument]), JSON.stringify(argument)).toEqual([argument]);
    }
    expect(existsSync(path.join(workingDirectory, "canary.txt"))).toBe(false);
  }, 120_000);

  it("is not read for !NAME!, which a shell with delayed expansion replaces even inside quotation marks", async () => {
    env = { ...env, BRIDGE_SHELL_TEST: "expanded" };
    const { file } = windowsShellInvocation("plain-launcher", [])!;

    // The registry can turn delayed expansion on for every shell; /v:on does it for this one.
    const { stdout } = await getProcessHost().execFile(
      file,
      ["/d", "/v:on", "/c", "plain-launcher \"!BRIDGE_SHELL_TEST!\""],
      { encoding: "utf-8", windowsVerbatimArguments: true, env, cwd: workingDirectory, timeout: 30_000 },
    );
    expect(JSON.parse(stdout)).toEqual(["expanded"]);

    expect(await received("plain-launcher", ["!BRIDGE_SHELL_TEST!"])).toEqual(["!BRIDGE_SHELL_TEST!"]);
  });

  it("without the quoting, the same argument is run as a command: the hazard is real on this host", async () => {
    await getProcessHost().execFile("plain-launcher", ["a&echo x>unquoted-canary.txt"], {
      encoding: "utf-8",
      shell: true,
      env,
      cwd: workingDirectory,
      timeout: 30_000,
    });
    expect(existsSync(path.join(workingDirectory, "unquoted-canary.txt"))).toBe(true);
  });
});
