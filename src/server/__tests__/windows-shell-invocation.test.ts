import { describe, expect, it } from "vitest";

import { windowsShellInvocation } from "../platform.js";

const ENV = { SystemRoot: "D:\\Windows" };

/** The command line the shell is given for one argument, without the launcher's name. */
function written(argument: string): string | undefined {
  const line = windowsShellInvocation("launcher", [argument], ENV)?.args.at(-1);
  return line?.slice("\"launcher ".length, -1);
}

// What the shell and a real launcher script make of these is tested on Windows itself, in
// windows-shell-argument.native.test.ts. This pins the text, which every host can check.
describe("windowsShellInvocation", () => {
  it("starts the system's own command shell with its settings fixed and the whole command as one quoted line", () => {
    expect(windowsShellInvocation("agent-browser", ["open", "https://duck.com/?q=a&ia=web"], ENV)).toEqual({
      file: "D:\\Windows\\System32\\cmd.exe",
      args: ["/d", "/e:on", "/v:off", "/s", "/c", "\"agent-browser \"open\" \"https://duck.com/?q=a&ia=web\"\""],
      verbatim: true,
    });
  });

  it("quotes a command given by path, and only that: a quoted name would mislead the launcher about its own folder", () => {
    expect(windowsShellInvocation("C:\\Program Files\\tool\\run.cmd", ["a"], ENV)?.args.at(-1))
      .toBe("\"\"C:\\Program Files\\tool\\run.cmd\" \"a\"\"");
    expect(windowsShellInvocation("run&calc", ["a"], ENV)?.args.at(-1)).toBe("\"\"run&calc\" \"a\"\"");
  });

  it("looks for the shell in C:\\Windows when the system folder is not named", () => {
    expect(windowsShellInvocation("launcher", [], {})?.file).toBe("C:\\Windows\\System32\\cmd.exe");
  });

  it.each([
    ["", "\"\""],
    ["two words", "\"two words\""],
    ["a|b<c>d^e(f)", "\"a|b<c>d^e(f)\""],
    ["%PATH%", "\"%%cd:~,%PATH%%cd:~,%\""],
    ["100%", "\"100%%cd:~,%\""],
    ["say \"hi\"", "\"say \"\"hi\"\"\""],
    ["a\\\"b", "\"a\\\\\"\"b\""],
    ["C:\\dir\\", "\"C:\\dir\\\\\""],
    ["C:\\dir\\file", "\"C:\\dir\\file\""],
    ["a\\\\", "\"a\\\\\\\\\""],
  ])("writes %j as %j", (argument, quoted) => {
    expect(written(argument)).toBe(quoted);
  });

  it.each([
    ["a line feed", "a\nb"],
    ["a carriage return", "a\rb"],
    ["a null character", "a\0b"],
    ["more than the shell reads", "x".repeat(7500)],
    ["more than the shell reads once written out", "%".repeat(1200)],
  ])("has no way to pass %s", (_name, argument) => {
    expect(windowsShellInvocation("launcher", [argument], ENV)).toBeUndefined();
  });
});
