import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { makeTestDir } from "./helpers.js";
import {
  createCuaForegroundGuard,
  CUA_FOREGROUND_GRANT_MINUTES,
  cuaCallTakesForeground,
  CuaDriverInstaller,
  CuaForegroundGrants,
  getCuaInstallDir,
} from "../cua-driver.js";
import { createComputerUseToolDefinitions, FOREGROUND_ANSWERS } from "../tools/computer-use-tools.js";
import type { AppContext } from "../app-context.js";

describe("cuaCallTakesForeground", () => {
  it.each([
    ["bring_to_front", { pid: 1 }, true],
    ["invoke_menu", { pid: 1, path: ["File", "Save"] }, true],
    ["click", { pid: 1, element_token: "s1:2" }, false],
    // A token names its window, so Cua clicks it in the background with no pid.
    ["click", { element_token: "s1:2" }, false],
    ["click", { scope: "desktop", x: 5, y: 5 }, true],
    ["click", { pid: 1, x: 5, y: 5, delivery_mode: "foreground" }, true],
    ["type_text", { text: "hi" }, true],
    ["get_window_state", { pid: 1 }, false],
    ["launch_app", { path: "C:\\Apps\\example.exe" }, false],
    ["run_steps", { steps: [{ tool: "click", args: { pid: 1, element_token: "s1:2" } }] }, false],
    ["run_steps", { steps: [{ tool: "click", args: { pid: 1, element_token: "s1:2" } }], foreground_fallback: true }, true],
    ["run_steps", { steps: [{ tool: "bring_to_front", args: { pid: 1 } }] }, true],
    ["run_steps", { steps: [{ click: { element_token: "s1:2" } }] }, false],
    ["run_steps", { steps: [{ click: { element_token: "s1:2", delivery_mode: "foreground" } }] }, true],
    ["run_steps", { steps: [{ tool: "move_cursor", x: 5, y: 5 }] }, true],
    ["run_steps", { pid: 1, steps: [{ press_key: { key: "return" } }] }, false],
    ["run_steps", { steps: [{ press_key: { key: "return" } }] }, true],
    ["run_steps", { steps: [{ click: { app: "Notepad", role: "button", name: "Save" } }, { press_key: { key: "return" } }] }, false],
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

  it("lets a chat the user allowed use the foreground while they are active, until the grant expires", async () => {
    const clock = { t: 1_000_000 };
    const grants = new CuaForegroundGrants();
    const guard = createCuaForegroundGuard({ awayAfterMinutes: 3, readIdleSeconds: async () => 0, now: () => clock.t, grants });
    grants.grant("chat-a", clock.t);
    expect(await guard.beforeToolUse(front, { sessionId: "chat-a" })).toBeUndefined();
    guard.afterToolUse(front);
    expect(await guard.beforeToolUse(front, { sessionId: "chat-b" })).toMatchObject({ permissionDecision: "deny" });
    clock.t += CUA_FOREGROUND_GRANT_MINUTES * 60_000;
    expect(await guard.beforeToolUse(front, { sessionId: "chat-a" })).toMatchObject({ permissionDecision: "deny" });
  });
});

describe("computer_use_request_foreground", () => {
  function requestTool(
    answer: (form: { requestedSchema: any }) => { action: string; content?: Record<string, unknown> },
    idleSeconds = 0,
  ) {
    const grants = new CuaForegroundGrants();
    const asked = { count: 0 };
    const sessionManager = {
      canRequestElicitation: () => true,
      requestElicitation: async (_sessionId: string, form: { requestedSchema: any }) => {
        asked.count += 1;
        return answer(form);
      },
    };
    const [tool] = createComputerUseToolDefinitions(
      { sessionManager } as unknown as AppContext,
      { grants, readIdleSeconds: async () => idleSeconds },
    );
    return { grants, asked, call: () => tool.handler({ reason: "Click Save in Example Editor." }, { sessionId: "chat-a" }) as Promise<any> };
  }
  const field = (form: { requestedSchema: any }) => Object.keys(form.requestedSchema.properties)[0];

  it.each([
    ["the user's Allow", (form: any) => ({ action: "accept", content: { [field(form)]: FOREGROUND_ANSWERS.allow } }), true],
    ["Not now", (form: any) => ({ action: "accept", content: { [field(form)]: FOREGROUND_ANSWERS.deny } }), false],
    ["Bridge's automatic free-text answer", (form: any) => ({ action: "accept", content: { [field(form)]: "The user is away." } }), false],
    ["a dismissed form", () => ({ action: "cancel" }), false],
  ])("grants the foreground only for %s", async (_label, answer, expected) => {
    const { grants, call } = requestTool(answer);
    expect((await call()).granted).toBe(expected);
    expect(grants.activeUntil("chat-a") !== undefined).toBe(expected);
  });

  it("returns at once without asking when the user is already away", async () => {
    const { grants, asked, call } = requestTool(() => ({ action: "cancel" }), 200);
    expect(await call()).toMatchObject({ granted: false, userAway: true });
    expect(asked.count).toBe(0);
    expect(grants.activeUntil("chat-a")).toBeUndefined();
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
