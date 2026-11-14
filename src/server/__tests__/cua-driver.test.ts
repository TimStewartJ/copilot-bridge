import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { makeTestDir } from "./helpers.js";
import {
  createCuaForegroundGuard,
  cuaCallTakesForeground,
  CuaDriverInstaller,
  getCuaInstallDir,
} from "../cua-driver.js";

describe("cuaCallTakesForeground", () => {
  it.each([
    ["bring_to_front", { pid: 1 }, true],
    ["invoke_menu", { pid: 1, path: ["File", "Save"] }, true],
    ["click", { pid: 1, element_token: "s1:2" }, false],
    ["click", { pid: 1, x: 5, y: 5, delivery_mode: "foreground" }, true],
    ["type_text", { text: "hi" }, true],
    ["get_window_state", { pid: 1 }, false],
    ["run_steps", { steps: [{ tool: "click", args: { pid: 1, element_token: "s1:2" } }] }, false],
    ["run_steps", { steps: [{ tool: "click", args: { pid: 1, element_token: "s1:2" } }], foreground_fallback: true }, true],
    ["run_steps", { steps: [{ tool: "bring_to_front", args: { pid: 1 } }] }, true],
    ["run_script", { script: "const a = await cua.getApp('Notepad'); await a.click({role:'button'});" }, false],
    ["run_script", { script: "await cua.call('bring_to_front', {pid: 1});" }, true],
  ])("%s %j → %s", (tool, args, expected) => {
    expect(cuaCallTakesForeground(tool, args)).toBe(expected);
  });
});

describe("createCuaForegroundGuard", () => {
  function guardWith(idleSeconds: () => number | undefined, clock = { t: 1_000_000 }) {
    const guard = createCuaForegroundGuard({
      awayAfterMinutes: 3,
      readIdleSeconds: async () => idleSeconds(),
      now: () => clock.t,
    });
    return { guard, clock };
  }
  const front = { toolName: "cua-bring_to_front", toolArgs: { pid: 1 } };

  it("leaves background calls and other tools alone even while the user is active", async () => {
    const { guard } = guardWith(() => 0);
    expect(await guard.beforeToolUse({ toolName: "cua-click", toolArgs: { pid: 1, element_token: "s1:2" } })).toBeUndefined();
    expect(await guard.beforeToolUse({ toolName: "powershell", toolArgs: { command: "bring_to_front" } })).toBeUndefined();
  });

  it("refuses the foreground while the user is active or unknown, and allows it once they are away", async () => {
    let idle: number | undefined = 30;
    const { guard } = guardWith(() => idle);
    expect(await guard.beforeToolUse(front)).toMatchObject({ permissionDecision: "deny" });
    idle = undefined;
    expect(await guard.beforeToolUse(front)).toMatchObject({ permissionDecision: "deny" });
    idle = 200;
    expect(await guard.beforeToolUse(front)).toBeUndefined();
  });

  it("does not count the chat's own input as the user coming back, but does count input after a pause", async () => {
    let idle = 200;
    const { guard, clock } = guardWith(() => idle);
    expect(await guard.beforeToolUse(front)).toBeUndefined();
    // Cua's input during the call resets the idle timer.
    clock.t += 1_000;
    guard.afterToolUse(front);
    idle = 1;
    clock.t += 500;
    expect(await guard.beforeToolUse(front)).toBeUndefined();
    guard.afterToolUse(front);

    // Ten seconds after the last call ends, the user types.
    clock.t += 10_000;
    idle = 0;
    expect(await guard.beforeToolUse(front)).toMatchObject({ permissionDecision: "deny" });
  });

  it("refuses when the idle check itself fails", async () => {
    const guard = createCuaForegroundGuard({ awayAfterMinutes: 3, readIdleSeconds: async () => { throw new Error("koffi missing"); } });
    expect(await guard.beforeToolUse(front)).toMatchObject({ permissionDecision: "deny" });
  });
});

describe("CuaDriverInstaller", () => {
  it("rejects a download that does not match the pinned digest and installs nothing", async () => {
    const dataDir = makeTestDir("cua-install-tampered");
    const installer = new CuaDriverInstaller({
      dataDir,
      target: "win32-x64",
      fetch: (async () => new Response(new Uint8Array(Buffer.from("tampered")), { status: 200 })) as unknown as typeof fetch,
      extract: async () => { throw new Error("extract must not run"); },
      logger: { log: () => undefined, warn: () => undefined, error: () => undefined },
    });

    await expect(installer.install()).rejects.toThrow("integrity check");
    expect(installer.getStatus()).toMatchObject({ supported: true, installed: false, installing: false });
    expect(existsSync(join(getCuaInstallDir(dataDir), "cua-driver.exe"))).toBe(false);
  });

  it("is unsupported where no build is pinned", () => {
    const installer = new CuaDriverInstaller({ dataDir: makeTestDir("cua-install-linux"), target: "linux-x64" });
    expect(installer.getStatus()).toMatchObject({ supported: false, installed: false });
  });
});
