import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { BrowserCommand, BrowserCommandResult } from "../agent-browser.js";
import { runBrowserAutomationCommands, withScreenshots } from "../browser-automation.js";
import { normalizeBrowserAutomationCommands } from "../browser-steps.js";
import { saveDownload, takeScreenshot } from "../browser-step-files.js";
import { toolFailureWithContext } from "../tool-results.js";

const check = (command: string, ...args: string[]) => normalizeBrowserAutomationCommands([{ command, args }]);

describe("browser steps", () => {
  it.each([
    ["drag", ["@e1", "@e2", "--human"]],
    ["hover", ["@e1"]],
    ["get", ["attr", "@e1", "src"]],
    ["mouse", ["move", "10", "20", "--steps", "12"]],
    ["tab", ["new", "https://example.com/"]],
    ["eval", ["document.title"]],
    ["back", []],
    ["wait", ["--fn", "window.ready"]],
    ["fill", ["@e1", "-5"]],
    ["fill", ["@e1", "- a list item"]],
    ["fill", ["@e1", "--not an option"]],
    ["screenshot", ["@e1", "--full"]],
  ])("accepts %s %j", (command, args) => {
    expect(check(command, ...args)).toEqual({ ok: true, value: [{ command, args, timeoutMs: undefined }] });
  });

  // agent-browser reads its options wherever they stand, so these would act on another browser.
  it.each([
    ["get", ["url", "--session", "other"]],
    ["click", ["--cdp"]],
    ["open", ["--profile=/somewhere"]],
    ["fill", ["@e1", "--headed"]],
    ["type", ["@e1", "-v"]],
    ["press", ["--json"]],
    ["eval", ["1", "-p", "x"]],
    ["snapshot", ["-i", "--session=a\nb"]],
    ["wait", ["--download"]],
    ["wait", ["#spinner", "--state", "hidden"]],
    ["screenshot", ["--screenshot-dir", "/tmp"]],
  ])("refuses the option in %s %j", (command, args) => {
    const result = check(command, ...args);

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toMatch(/agent-browser would read it as one of its own options|supports|requires/);
  });

  it.each(["close", "quit", "exit", "connect", "session", "stream", "state", "auth", "batch", "goto", "navigate", "--session", "Open", ""])(
    "refuses %j as a step",
    (command) => {
      const result = check(command);

      expect(result.ok).toBe(false);
      expect(!result.ok && result.error).toContain("is not a browser step");
    },
  );

  it("keeps a CSS selector of a passed-through command as it is", () => {
    expect(check("hover", "h1")).toMatchObject({ ok: true, value: [{ args: ["h1"] }] });
  });

  it("limits the screenshots of one call", () => {
    const shots = (count: number) => normalizeBrowserAutomationCommands(Array.from({ length: count }, () => ({ command: "screenshot" })));

    expect(shots(6).ok).toBe(true);
    expect(shots(7)).toEqual({ ok: false, error: "commands may take at most 6 screenshots in one call" });
  });
});

/** A JPEG that is only its headers: enough to carry a size. */
function jpeg(width: number, height: number): Buffer {
  const frame = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x4a, 0x46]), frame, Buffer.from([0xff, 0xd9])]);
}

describe("file steps", () => {
  let folder: string;

  beforeAll(async () => {
    folder = await mkdtemp(join(tmpdir(), "bridge-steps-"));
  });
  afterAll(async () => {
    await rm(folder, { recursive: true, force: true });
  });

  /** agent-browser writing `image` to the path a screenshot command names. */
  const screenshots = (image: Buffer, data: Record<string, unknown> = {}) =>
    vi.fn(async (command: BrowserCommand): Promise<BrowserCommandResult> => {
      const path = command.find((arg) => /\.(jpg|png)$/.test(arg))!;
      await writeFile(path, image);
      return { ok: true, output: "", data: { path, ...data } };
    });

  it("returns the visible page as a picture and keeps no file", async () => {
    const runCommand = screenshots(jpeg(945, 917));

    const result = await takeScreenshot([], 5_000, {}, { runCommand });

    expect(result).toEqual({
      ok: true,
      output: "Screenshot attached (945x917).",
      image: { data: jpeg(945, 917).toString("base64"), mimeType: "image/jpeg" },
    });
    const [command, timeout, options] = runCommand.mock.calls[0] as unknown as [string[], number, object];
    expect(command).toEqual(["screenshot", command[1], "--screenshot-format", "jpeg", "--screenshot-quality", "70"]);
    expect([timeout, options]).toEqual([5_000, { skipRecovery: true }]);
    await expect(stat(command[1])).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("takes one element, keeps the picture in the chat's files and lists the labels of an annotated one", async () => {
    const runCommand = screenshots(jpeg(90, 90), { annotations: [{ ref: "e15", role: "button", name: "A1 photo" }] });

    const result = await takeScreenshot(["@e15", "grid.jpg", "--annotate"], undefined, {}, { runCommand, filesDir: join(folder, "chat") });

    const kept = join(folder, "chat", "grid.jpg");
    expect(result.output).toBe(`Screenshot attached (90x90), saved to ${kept}.\n@e15 button "A1 photo"`);
    expect(runCommand.mock.calls[0][0].slice(0, 4)).toEqual(["screenshot", "@e15", kept, "--annotate"]);
    await expect(readFile(kept)).resolves.toEqual(jpeg(90, 90));
  });

  it.each([
    ["taller than a provider accepts", jpeg(945, 12_000), "The screenshot is too large to show (945x12000, 29 bytes). Take the visible page without --full, or one element."],
    ["not a picture", Buffer.from("not an image"), "The screenshot is too large to show (12 bytes). Take the visible page without --full, or one element."],
  ])("attaches nothing for a screenshot that is %s", async (_label, image, output) => {
    const result = await takeScreenshot(["--full"], undefined, {}, { runCommand: screenshots(image) });

    expect(result).toEqual({ ok: false, output });
  });

  it("keeps a screenshot that is too large to show, and says so", async () => {
    const kept = join(folder, "long-page.png");

    const result = await takeScreenshot([kept, "--full"], undefined, {}, { runCommand: screenshots(jpeg(945, 12_000)) });

    expect(result).toEqual({ ok: true, output: `Screenshot saved to ${kept}, but too large to show (945x12000, 29 bytes).` });
    await expect(stat(kept)).resolves.toBeTruthy();
  });

  it("takes an argument that only starts with a dash as the file, never as an option", async () => {
    const runCommand = screenshots(jpeg(10, 10));

    const result = await takeScreenshot(["-"], undefined, {}, { runCommand });

    expect(result).toEqual({ ok: false, output: "screenshot takes absolute file paths: -" });
    expect(runCommand).not.toHaveBeenCalled();
  });

  it("stops a call whose screenshots are too large together, keeping the ones that fit", async () => {
    const runCommand = screenshots(Buffer.concat([jpeg(945, 917), Buffer.alloc(2_500_000)]));

    const result = await runBrowserAutomationCommands(
      [{ command: "screenshot", args: [] }, { command: "screenshot", args: [] }, { command: "screenshot", args: [] }],
      {},
      { runCommand },
    );

    expect(result).toMatchObject({
      ok: false,
      error: {
        error: "Command 3 failed: screenshot",
        failedStep: { output: "This call's screenshots are too large together. Take the rest in another call." },
      },
    });
    expect(!result.ok && result.error.images).toHaveLength(2);
  });

  it("returns the failure of the screenshot command", async () => {
    const runCommand = vi.fn(async (): Promise<BrowserCommandResult> => ({ ok: false, output: "Unknown ref: e9" }));

    await expect(takeScreenshot(["@e9"], undefined, {}, { runCommand })).resolves.toEqual({ ok: false, output: "Unknown ref: e9" });
  });

  it("saves a download in the chat's files", async () => {
    const runCommand = vi.fn(async (): Promise<BrowserCommandResult> => ({ ok: true, output: "", data: {} }));
    const saved = join(folder, "new-chat", "report.pdf");

    const result = await saveDownload(["@e5", "report.pdf"], 9_000, {}, { runCommand, filesDir: join(folder, "new-chat") });

    expect(result).toEqual({ ok: true, output: `Saved the download to ${saved}.` });
    expect(runCommand).toHaveBeenCalledWith(["download", "@e5", saved], 9_000, { skipRecovery: true });
    await expect(stat(join(folder, "new-chat"))).resolves.toBeTruthy();
  });

  it("downloads nothing to a file it cannot place", async () => {
    const runCommand = vi.fn();

    await expect(saveDownload(["@e5", "report.pdf"], undefined, {}, { runCommand }))
      .resolves.toEqual({ ok: false, output: "download takes absolute file paths: report.pdf" });
    await expect(saveDownload(["@e5", join("..", "report.pdf")], undefined, {}, { runCommand, filesDir: folder }))
      .resolves.toMatchObject({ ok: false });
    expect(runCommand).not.toHaveBeenCalled();
  });
});

describe("withScreenshots", () => {
  const images = [{ data: "AAAA", mimeType: "image/jpeg" }];
  const pictures = [{ type: "image", data: "AAAA", mimeType: "image/jpeg" }];

  it("leaves a result without screenshots as it is", () => {
    const result = { steps: [] };

    expect(withScreenshots(result, [])).toBe(result);
  });

  it("sends the screenshots along with a result, also with one that failed", () => {
    expect(withScreenshots({ context: "public", steps: [] }, images)).toEqual({
      textResultForLlm: JSON.stringify({ context: "public", steps: [] }, null, 2),
      resultType: "success",
      binaryResultsForLlm: pictures,
    });
    const failure = toolFailureWithContext("Command 2 failed: click", { context: "public" }, { detail: "Unknown ref: e9" });
    expect(withScreenshots(failure, images)).toEqual({ ...failure, binaryResultsForLlm: pictures });
  });
});
