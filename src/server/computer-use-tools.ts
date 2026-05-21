// computer-use-tools.ts — Bridge-native desktop automation tools
// Uses the native computer.node addon bundled with @github/copilot to provide
// screenshot, click, type, key, scroll, and clipboard tools directly to the agent.
// Gated by COMPUTER_USE=true environment variable.

import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { defineTool } from "@github/copilot-sdk";
import type { AppContext } from "./app-context.js";
import { ab, getBrowserLaunchConfig, isAgentBrowserInstalled, safeRecordBrowserSpan, withBridgeBrowserSession } from "./agent-browser.js";
import { getOrCreateBrowserSessionStore } from "./browser-session-store.js";
import { requireToolHandlers } from "./tool-handler.js";
import { toolFailure } from "./tool-results.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const COMPUTER_USE_ENABLED = process.env.COMPUTER_USE?.toLowerCase() === "true";

interface ComputerModule {
  screenshot(displayId: string, allowedApps: string[], targetW: number, targetH: number, cropX: number, cropY: number, cropW: number, cropH: number, quality: number): Buffer | null;
  click(displayId: string, allowedApps: string[], x: number, y: number, button?: number): void;
  move(displayId: string, allowedApps: string[], x: number, y: number): void;
  drag(displayId: string, allowedApps: string[], fromX: number, fromY: number, toX: number, toY: number): void;
  type(text: string): void;
  key(combo: string): void;
  scroll(displayId: string, allowedApps: string[], x: number, y: number, deltaX: number, deltaY: number): void;
  cursorPosition(displayId: string): { x: number; y: number };
  display(): { width: number; height: number; pixelWidth: number; pixelHeight: number };
  getClipboard(): string;
  setClipboard(text: string): void;
  checkPermissions?(permission: "accessibility" | "screen"): boolean;
}

let _mod: ComputerModule | null = null;
let _loadError: string | null = null;
let computerUseQueue: Promise<void> = Promise.resolve();

type DesktopPermission = "accessibility" | "screen";

const AGENT_BROWSER_INSTALL_GUIDANCE =
  "agent-browser is not installed. Install it with: npm install -g agent-browser && agent-browser install";

function safeUrlHost(url: string): string | undefined {
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function getPermissionError(mod: ComputerModule, permissions: readonly DesktopPermission[]): string | null {
  if (typeof mod.checkPermissions !== "function" || permissions.length === 0) return null;
  const missing = permissions.filter((permission) => {
    try {
      return !mod.checkPermissions?.(permission);
    } catch {
      return false;
    }
  });
  if (missing.length === 0) return null;
  const labels = missing.map((permission) => permission === "screen" ? "Screen Recording" : "Accessibility");
  return `Missing desktop permissions: ${labels.join(", ")}. Grant them to the bridge process or terminal in OS settings, then try again.`;
}

function unexpectedComputerToolFailure(summary: string, err: unknown) {
  const detail = `${summary}: ${err instanceof Error ? err.message : String(err)}`.slice(0, 240);
  return toolFailure(summary, {
    detail,
    sessionLog: detail,
  });
}

async function withComputerToolResult<T>(summary: string, fn: () => Promise<T>) {
  try {
    return await withComputerUseLock(fn);
  } catch (err) {
    return unexpectedComputerToolFailure(summary, err);
  }
}

async function withComputerUseLock<T>(fn: () => Promise<T>): Promise<T> {
  const waitForTurn = computerUseQueue.catch(() => undefined);
  let release!: () => void;
  computerUseQueue = new Promise<void>((resolve) => {
    release = resolve;
  });
  await waitForTurn;
  try {
    return await fn();
  } finally {
    release();
  }
}

function getComputerModule(): ComputerModule {
  if (_mod) return _mod;
  if (_loadError) throw new Error(_loadError);
  try {
    const bindingDir = join(
      __dirname, "..", "..",
      "node_modules", "@github", "copilot", "prebuilds",
      `${process.platform}-${process.arch}`,
    );
    const require = createRequire(import.meta.url);
    _mod = require(join(bindingDir, "computer.node")) as ComputerModule;
    console.log("[computer-use] Native module loaded successfully");
    return _mod;
  } catch (e) {
    _loadError = `Failed to load computer.node: ${e instanceof Error ? e.message : String(e)}`;
    console.error(`[computer-use] ${_loadError}`);
    throw new Error(_loadError);
  }
}

export function createComputerUseTools(ctx: AppContext) {
  if (!COMPUTER_USE_ENABLED) return [];

  // Eagerly try to load — log warning at startup if bindings aren't available
  try {
    const mod = getComputerModule();
    const startupPermissionError = getPermissionError(mod, ["screen", "accessibility"]);
    if (startupPermissionError) {
      console.warn(`[computer-use] ${startupPermissionError}`);
    }
  } catch {
    console.warn("[computer-use] COMPUTER_USE=true but native bindings unavailable — tools will error at runtime");
  }

  const browserSessionStore = getOrCreateBrowserSessionStore(ctx, {
    copilotHome: ctx.copilotHome,
    telemetryStore: ctx.telemetryStore,
    getBrowserLaunchConfig: () => getBrowserLaunchConfig(ctx.settingsStore.getSettings()),
  });

  const tools = requireToolHandlers([
    defineTool("computer_screenshot", {
      description:
        "Take a screenshot of the desktop. Returns the image as a base64-encoded PNG. " +
        "Optionally crop to a specific region by providing x, y, width, height.",
      parameters: {
        type: "object" as const,
        properties: {
          x: { type: "number", description: "Crop region X offset (pixels from left)" },
          y: { type: "number", description: "Crop region Y offset (pixels from top)" },
          width: { type: "number", description: "Crop region width in pixels" },
          height: { type: "number", description: "Crop region height in pixels" },
        },
      },
      handler: async (args: any) => {
        return withComputerToolResult("Screenshot failed", async () => {
          const mod = getComputerModule();
          const permissionError = getPermissionError(mod, ["screen"]);
          if (permissionError) return toolFailure(permissionError);
          const display = mod.display();
          const cropValuesProvided = [args.x, args.y, args.width, args.height].some((value) => value !== undefined && value !== null);
          const hasCrop = args.x != null && args.y != null && args.width != null && args.height != null;
          if (cropValuesProvided && !hasCrop) {
            return toolFailure("Provide all of x, y, width, and height to crop a screenshot");
          }
          if (hasCrop) {
            if (
              !isNonNegativeInteger(args.x) ||
              !isNonNegativeInteger(args.y) ||
              !isNonNegativeInteger(args.width) ||
              !isNonNegativeInteger(args.height)
            ) {
              return toolFailure("x, y, width, and height must be non-negative integers");
            }
            if (args.width === 0 || args.height === 0) {
              return toolFailure("width and height must be greater than zero");
            }
            if ((args.x + args.width) > display.width || (args.y + args.height) > display.height) {
              return toolFailure(
                `Crop region (${args.x}, ${args.y}, ${args.width}, ${args.height}) ` +
                `is outside display bounds ${display.width}x${display.height}`,
              );
            }
          }
          const buf = mod.screenshot(
            "", [], display.width, display.height,
            hasCrop ? args.x : 0, hasCrop ? args.y : 0,
            hasCrop ? args.width : 0, hasCrop ? args.height : 0,
            -1, // PNG
          );
          if (!buf) return toolFailure("Screenshot failed");
          return {
            type: "image",
            mimeType: "image/png",
            data: Buffer.from(buf).toString("base64"),
            width: hasCrop ? args.width : display.width,
            height: hasCrop ? args.height : display.height,
          };
        });
      },
    }),

    defineTool("computer_click", {
      description:
        "Click the mouse at the specified coordinates. Supports left, right, middle, and double click.",
      parameters: {
        type: "object" as const,
        properties: {
          x: { type: "number", description: "X coordinate (pixels from left)" },
          y: { type: "number", description: "Y coordinate (pixels from top)" },
          button: {
            type: "string",
            enum: ["left", "right", "middle", "double"],
            description: "Mouse button to click. Defaults to 'left'.",
          },
        },
        required: ["x", "y"],
      },
      handler: async (args: any) => {
        return withComputerToolResult("Click failed", async () => {
          const mod = getComputerModule();
          const permissionError = getPermissionError(mod, ["accessibility"]);
          if (permissionError) return toolFailure(permissionError);
          const button = args.button ?? "left";
          if (button === "double") {
            mod.click("", [], args.x, args.y, 0);
            mod.click("", [], args.x, args.y, 0);
          } else {
            const buttonMap: Record<string, number> = { left: 0, right: 1, middle: 2 };
            mod.click("", [], args.x, args.y, buttonMap[button] ?? 0);
          }
          return { success: true, message: `${button} click at (${args.x}, ${args.y})` };
        });
      },
    }),

    defineTool("computer_type", {
      description:
        "Type text using the keyboard. The text is typed as if the user pressed each key. " +
        "For special keys or key combinations, use computer_key instead.",
      parameters: {
        type: "object" as const,
        properties: {
          text: { type: "string", description: "Text to type" },
        },
        required: ["text"],
      },
      handler: async (args: any) => {
        return withComputerToolResult("Typing failed", async () => {
          const mod = getComputerModule();
          const permissionError = getPermissionError(mod, ["accessibility"]);
          if (permissionError) return toolFailure(permissionError);
          mod.type(args.text);
          return { success: true, message: `Typed ${args.text.length} character(s)` };
        });
      },
    }),

    defineTool("computer_key", {
      description:
        "Send a key combination. Use '+' to combine modifier keys. " +
        "Examples: 'enter', 'ctrl+c', 'ctrl+shift+t', 'alt+tab', 'cmd+a', 'backspace', 'escape', 'tab', " +
        "'up', 'down', 'left', 'right', 'space', 'f1' through 'f12'.",
      parameters: {
        type: "object" as const,
        properties: {
          combo: { type: "string", description: "Key combination (e.g. 'ctrl+c', 'enter', 'alt+tab')" },
        },
        required: ["combo"],
      },
      handler: async (args: any) => {
        return withComputerToolResult("Key press failed", async () => {
          const mod = getComputerModule();
          const permissionError = getPermissionError(mod, ["accessibility"]);
          if (permissionError) return toolFailure(permissionError);
          mod.key(args.combo);
          return { success: true, message: `Pressed ${args.combo}` };
        });
      },
    }),

    defineTool("computer_cursor_position", {
      description: "Get the current mouse cursor position on screen.",
      parameters: { type: "object" as const, properties: {} },
      handler: async () => {
        return withComputerToolResult("Failed to read cursor position", async () => {
          const mod = getComputerModule();
          const permissionError = getPermissionError(mod, ["accessibility"]);
          if (permissionError) return toolFailure(permissionError);
          const pos = mod.cursorPosition("");
          return { x: pos.x, y: pos.y };
        });
      },
    }),

    defineTool("computer_scroll", {
      description:
        "Scroll the mouse wheel at the specified coordinates. " +
        "Use positive scrollY to scroll down, negative to scroll up. " +
        "Use scrollX for horizontal scrolling.",
      parameters: {
        type: "object" as const,
        properties: {
          x: { type: "number", description: "X coordinate where to scroll" },
          y: { type: "number", description: "Y coordinate where to scroll" },
          scrollY: { type: "number", description: "Vertical scroll amount (positive = down, negative = up). Defaults to 3." },
          scrollX: { type: "number", description: "Horizontal scroll amount (positive = right). Defaults to 0." },
        },
        required: ["x", "y"],
      },
      handler: async (args: any) => {
        return withComputerToolResult("Scroll failed", async () => {
          const mod = getComputerModule();
          const permissionError = getPermissionError(mod, ["accessibility"]);
          if (permissionError) return toolFailure(permissionError);
          const deltaX = args.scrollX ?? 0;
          const deltaY = args.scrollY ?? 3;
          mod.scroll("", [], args.x, args.y, deltaX, deltaY);
          return { success: true, message: `Scrolled at (${args.x}, ${args.y}) by (${deltaX}, ${deltaY})` };
        });
      },
    }),

    defineTool("computer_move", {
      description: "Move the mouse cursor to the specified coordinates without clicking.",
      parameters: {
        type: "object" as const,
        properties: {
          x: { type: "number", description: "X coordinate (pixels from left)" },
          y: { type: "number", description: "Y coordinate (pixels from top)" },
        },
        required: ["x", "y"],
      },
      handler: async (args: any) => {
        return withComputerToolResult("Move failed", async () => {
          const mod = getComputerModule();
          const permissionError = getPermissionError(mod, ["accessibility"]);
          if (permissionError) return toolFailure(permissionError);
          mod.move("", [], args.x, args.y);
          return { success: true, message: `Moved cursor to (${args.x}, ${args.y})` };
        });
      },
    }),

    defineTool("computer_drag", {
      description: "Drag from one coordinate to another (press, move, release).",
      parameters: {
        type: "object" as const,
        properties: {
          fromX: { type: "number", description: "Start X coordinate" },
          fromY: { type: "number", description: "Start Y coordinate" },
          toX: { type: "number", description: "End X coordinate" },
          toY: { type: "number", description: "End Y coordinate" },
        },
        required: ["fromX", "fromY", "toX", "toY"],
      },
      handler: async (args: any) => {
        return withComputerToolResult("Drag failed", async () => {
          const mod = getComputerModule();
          const permissionError = getPermissionError(mod, ["accessibility"]);
          if (permissionError) return toolFailure(permissionError);
          mod.drag("", [], args.fromX, args.fromY, args.toX, args.toY);
          return { success: true, message: `Dragged from (${args.fromX}, ${args.fromY}) to (${args.toX}, ${args.toY})` };
        });
      },
    }),

    defineTool("computer_clipboard_read", {
      description: "Read the current contents of the system clipboard.",
      parameters: { type: "object" as const, properties: {} },
      handler: async () => {
        return withComputerToolResult("Failed to read clipboard", async () => {
          const mod = getComputerModule();
          const text = mod.getClipboard();
          return { text };
        });
      },
    }),

    defineTool("computer_clipboard_write", {
      description: "Write text to the system clipboard.",
      parameters: {
        type: "object" as const,
        properties: {
          text: { type: "string", description: "Text to copy to clipboard" },
        },
        required: ["text"],
      },
      handler: async (args: any) => {
        return withComputerToolResult("Failed to write clipboard", async () => {
          const mod = getComputerModule();
          mod.setClipboard(args.text);
          return { success: true, message: `Copied ${args.text.length} character(s) to clipboard` };
        });
      },
    }),

    defineTool("computer_display_info", {
      description: "Get the current display dimensions and resolution.",
      parameters: { type: "object" as const, properties: {} },
      handler: async () => {
        return withComputerToolResult("Failed to read display info", async () => {
          const mod = getComputerModule();
          return mod.display();
        });
      },
    }),

    defineTool("computer_open_browser", {
      description:
        "Open a URL in a visible browser window on the desktop for computer-use interaction. " +
        "The browser window is visible in screenshots and can be controlled with computer_click, " +
        "computer_type, and computer_key. Use this for complex/heavy websites where browser_fetch " +
        "or browser_exec struggle (shopping sites, SPAs, etc.). Returns a browserSessionId — " +
        "close it with browser_session_close when done. After opening, use computer_screenshot " +
        "to see the page and computer_click to interact.",
      parameters: {
        type: "object" as const,
        properties: {
          url: { type: "string", description: "URL to open in the browser" },
        },
        required: ["url"],
      },
      handler: async (args: any, invocation) => {
        return withComputerToolResult("Failed to open browser", async () => {
          const browserOpId = randomUUID();
          const check = await isAgentBrowserInstalled();
          if (!check) {
            return toolFailure("agent-browser is not installed.", {
              detail: AGENT_BROWSER_INSTALL_GUIDANCE,
              sessionLog: AGENT_BROWSER_INSTALL_GUIDANCE,
            });
          }
          const urlHost = safeUrlHost(args.url);

          let record;
          try {
            record = await browserSessionStore.createSession(
              invocation.sessionId,
              "isolated",
              urlHost ? `computer-use: ${urlHost}` : "computer-use",
            );
          } catch (err: any) {
            const detail = `Failed to create browser session: ${String(err).slice(0, 200)}`;
            return toolFailure("Failed to create browser session.", {
              detail,
              sessionLog: detail,
            });
          }

          try {
            const headedTarget = { ...record.browserTarget, headed: true };
            const openResult = await withBridgeBrowserSession(headedTarget, async () => {
              return ab(["open", args.url], 30_000, {
                browserTarget: headedTarget,
                telemetryStore: ctx.telemetryStore,
                toolName: "computer_open_browser",
                browserOpId,
                metadata: { urlHost },
              });
            });
            if (!openResult.ok) {
              await browserSessionStore.closeSession(record.id, invocation.sessionId, true);
              const detail = `Failed to open URL: ${openResult.output.slice(0, 200)}`;
              return toolFailure("Failed to open URL.", {
                detail,
                sessionLog: detail,
              });
            }
          } catch (err: any) {
            try {
              await browserSessionStore.closeSession(record.id, invocation.sessionId, true);
            } catch {}
            const detail = `Failed to open URL: ${String(err).slice(0, 200)}`;
            return toolFailure("Failed to open URL.", {
              detail,
              sessionLog: detail,
            });
          }

          safeRecordBrowserSpan(ctx.telemetryStore, "browser.tool.computer_open_browser", 0, {
            browserOpId,
            browserSessionId: record.id,
            urlHost,
          });

          let display = { width: 1920, height: 1080 };
          try {
            const mod = getComputerModule();
            const d = mod.display();
            display = { width: d.width, height: d.height };
          } catch {}

          return {
            browserSessionId: record.id,
            display,
            message: `Browser opened at ${args.url}. Use computer_screenshot to see the page, ` +
              `computer_click/computer_type/computer_key to interact. ` +
              `Close with browser_session_close({ browserSessionId: "${record.id}" }) when done.`,
          };
        });
      },
    }),
  ]);

  console.log(`[computer-use] Registered ${tools.length} tools: ${tools.map(t => t.name).join(", ")}`);
  return tools;
}
