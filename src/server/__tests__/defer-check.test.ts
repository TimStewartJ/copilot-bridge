import { win32 } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveDeferCheckInvocation } from "../defer-check.js";

// Windows paths are built with path.win32, and file lookups are answered from this list, so the
// Windows branch runs the same on every host.
const TOOLS = "C:\\Tools";
const NODE_BIN = "C:\\Users\\user\\AppData\\Roaming\\npm";
const WORKSPACE = "C:\\work\\repo";
const env = { Path: [TOOLS, NODE_BIN].join(win32.delimiter), PATHEXT: ".COM;.EXE;.BAT;.CMD;.VBS;.JS" };
const files = new Set([
  win32.join(TOOLS, "gh.exe"),
  win32.join(NODE_BIN, "az.cmd"),
  win32.join(WORKSPACE, "scripts", "status.bat"),
]);
const isFile = async (path: string) => files.has(path);
const cmd = "C:\\Windows\\System32\\cmd.exe";

describe("resolveDeferCheckInvocation", () => {
  it.each([
    {
      name: "starts a command as given off Windows",
      platform: "linux" as const,
      command: ["az", "pipelines", "runs", "show"],
      expected: { file: "az", args: ["pipelines", "runs", "show"], verbatim: false },
    },
    {
      name: "starts a program found on PATH directly",
      platform: "win32" as const,
      command: ["gh", "pr", "checks", "7"],
      expected: { file: win32.join(TOOLS, "gh.exe"), args: ["pr", "checks", "7"], verbatim: false },
    },
    {
      name: "runs a .cmd launcher through cmd.exe with each argument quoted",
      platform: "win32" as const,
      command: ["az", "rest", "--url", "https://example.com/a?b=1&c=%PATH%"],
      expected: {
        file: cmd,
        args: [
          "/d", "/e:on", "/v:off", "/s", "/c",
          `""${win32.join(NODE_BIN, "az.cmd")}" "rest" "--url" "https://example.com/a?b=1&c=%%cd:~,%PATH%%cd:~,%""`,
        ],
        verbatim: true,
      },
    },
    {
      name: "resolves a relative launcher path against the check's folder",
      platform: "win32" as const,
      command: ["scripts\\status"],
      expected: {
        file: cmd,
        args: ["/d", "/e:on", "/v:off", "/s", "/c", `""${win32.join(WORKSPACE, "scripts", "status.bat")}""`],
        verbatim: true,
      },
    },
    {
      name: "leaves a name it cannot find for the start to report",
      platform: "win32" as const,
      command: ["missing-cli", "--version"],
      expected: { file: "missing-cli", args: ["--version"], verbatim: false },
    },
  ])("$name", async ({ platform, command, expected }) => {
    await expect(resolveDeferCheckInvocation(command, WORKSPACE, {
      platform,
      env: { ...env, SystemRoot: "C:\\Windows" },
      isFile,
    })).resolves.toEqual(expected);
  });
});
