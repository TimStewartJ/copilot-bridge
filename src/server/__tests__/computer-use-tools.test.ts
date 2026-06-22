import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const nativeRequireMock = vi.fn();
const execMock = vi.fn();
const execFileMock = vi.fn();
const consoleErrorMock = vi.spyOn(console, "error").mockImplementation(() => {});
const consoleLogMock = vi.spyOn(console, "log").mockImplementation(() => {});
const consoleWarnMock = vi.spyOn(console, "warn").mockImplementation(() => {});

vi.mock("node:module", async () => {
  const actual = await vi.importActual<typeof import("node:module")>("node:module");
  return {
    ...actual,
    createRequire: () => nativeRequireMock,
  };
});

vi.mock("node:child_process", () => ({
  exec: execMock,
  execFile: execFileMock,
}));

function createComputerModule(overrides: Partial<Record<string, any>> = {}) {
  return {
    screenshot: vi.fn(() => Buffer.from("png")),
    click: vi.fn(),
    move: vi.fn(),
    drag: vi.fn(),
    type: vi.fn(),
    key: vi.fn(),
    scroll: vi.fn(),
    cursorPosition: vi.fn(() => ({ x: 10, y: 20 })),
    display: vi.fn(() => ({ width: 1280, height: 720, pixelWidth: 2560, pixelHeight: 1440 })),
    getClipboard: vi.fn(() => "clipboard"),
    setClipboard: vi.fn(),
    checkPermissions: vi.fn(() => true),
    ...overrides,
  };
}

describe("computer use tools", () => {
  beforeEach(() => {
    vi.resetModules();
    nativeRequireMock.mockReset();
    execMock.mockReset();
    execFileMock.mockReset();
    consoleErrorMock.mockClear();
    consoleLogMock.mockClear();
    consoleWarnMock.mockClear();
    vi.stubEnv("COMPUTER_USE", "true");
    execMock.mockImplementation((_cmd: string, _options: any, cb: (err: any, result?: { stdout: string; stderr: string }) => void) => {
      cb(null, { stdout: "agent-browser\n", stderr: "" });
      return {} as any;
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  afterAll(() => {
    consoleErrorMock.mockRestore();
    consoleLogMock.mockRestore();
    consoleWarnMock.mockRestore();
  });

  it("returns normalized failures when native bindings are unavailable", async () => {
    nativeRequireMock.mockImplementation(() => {
      throw new Error("missing native binding");
    });

    const mod = await import("../computer-use-tools.js");
    const tools = Object.fromEntries(mod.createStatelessComputerUseTools().map((tool: any) => [tool.name, tool]));
    const result = await tools.computer_screenshot.handler({}, {} as any) as any;

    expect(result).toEqual({
      textResultForLlm: "Screenshot failed: Failed to load computer.node: missing native binding",
      resultType: "failure",
      sessionLog: "Screenshot failed: Failed to load computer.node: missing native binding",
    });
  });

  it("returns normalized permission failures", async () => {
    nativeRequireMock.mockReturnValue(createComputerModule({
      checkPermissions: vi.fn((permission: "accessibility" | "screen") => permission !== "screen"),
    }));

    const mod = await import("../computer-use-tools.js");
    const tools = Object.fromEntries(mod.createStatelessComputerUseTools().map((tool: any) => [tool.name, tool]));
    const result = await tools.computer_screenshot.handler({}, {} as any) as any;

    expect(result).toEqual({
      textResultForLlm: "Missing desktop permissions: Screen Recording. Grant them to the bridge process or terminal in OS settings, then try again.",
      resultType: "failure",
      error: "Missing desktop permissions: Screen Recording. Grant them to the bridge process or terminal in OS settings, then try again.",
    });
  });

  it("labels screenshots by their actual bytes when the addon returns JPEG", async () => {
    const jpegBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
    nativeRequireMock.mockReturnValue(createComputerModule({
      screenshot: vi.fn(() => jpegBytes),
    }));

    const mod = await import("../computer-use-tools.js");
    const tools = Object.fromEntries(mod.createStatelessComputerUseTools().map((tool: any) => [tool.name, tool]));
    const result = await tools.computer_screenshot.handler({}, {} as any) as any;

    expect(result).toEqual({
      type: "image",
      mimeType: "image/jpeg",
      data: jpegBytes.toString("base64"),
    });
  });

  it("labels screenshots as PNG when the addon returns PNG bytes", async () => {
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
    nativeRequireMock.mockReturnValue(createComputerModule({
      screenshot: vi.fn(() => pngBytes),
    }));

    const mod = await import("../computer-use-tools.js");
    const tools = Object.fromEntries(mod.createStatelessComputerUseTools().map((tool: any) => [tool.name, tool]));
    const result = await tools.computer_screenshot.handler({}, {} as any) as any;

    expect(result).toMatchObject({ type: "image", mimeType: "image/png" });
  });

  it("returns normalized install guidance for computer_open_browser", async () => {
    nativeRequireMock.mockReturnValue(createComputerModule());
    execMock.mockImplementation((_cmd: string, _options: any, cb: (err: any) => void) => {
      cb(new Error("missing"));
      return {} as any;
    });

    const mod = await import("../computer-use-tools.js");
    const tools = Object.fromEntries(mod.createComputerUseTools({} as any).map((tool: any) => [tool.name, tool]));
    const result = await tools.computer_open_browser.handler({
      url: "https://example.com",
    }, { sessionId: "copilot-a" } as any);

    expect(result).toEqual({
      textResultForLlm: "agent-browser is not installed. Install it with: npm install -g agent-browser && agent-browser install",
      resultType: "failure",
      sessionLog: "agent-browser is not installed. Install it with: npm install -g agent-browser && agent-browser install",
    });
  });
});
