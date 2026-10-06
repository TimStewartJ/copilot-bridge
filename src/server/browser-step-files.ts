// The browser steps that read or write a file on the Bridge's machine: where the file is, and
// the two steps that are an agent-browser command plus a file (`screenshot` and `download`).
// `upload` has a module of its own, browser-upload.ts.

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, extname, isAbsolute, join } from "node:path";
import { ab, type BrowserCommandOptions, type BrowserCommandResult } from "./agent-browser.js";
import type { AppContext } from "./app-context.js";
import { SCREENSHOT_OPTIONS } from "./browser-steps.js";
import { getSessionFilesDir, isCanonicalSessionId } from "./outbound-attachments.js";
import { err, ok, type Result } from "./tool-results.js";

/**
 * One picture is refused by the model's provider above 5 MB once encoded or 8000 px a side, and
 * a refused picture stays in the conversation, which then fails on every later request.
 */
const MAX_SCREENSHOT_BYTES = 3_500_000;
const MAX_SCREENSHOT_SIDE = 7_900;

export interface BrowserStepFiles {
  /** The folder of the calling chat's files. A file named without a folder is looked up there. */
  filesDir?: string;
  runCommand?: typeof ab;
}

export interface BrowserStepImage {
  data: string;
  mimeType: string;
}

/** The files of a tool call: a file named without a folder is one of the calling chat's. */
export function chatStepFiles(ctx: Pick<AppContext, "copilotHome">, chatSessionId: string | undefined): BrowserStepFiles {
  return chatSessionId && isCanonicalSessionId(chatSessionId)
    ? { filesDir: getSessionFilesDir(ctx.copilotHome ?? join(homedir(), ".copilot"), chatSessionId) }
    : {};
}

/** The path a step means by `file`: an absolute path, or a name alone in the chat's files. */
export function stepFilePath(step: string, file: string, filesDir: string | undefined): Result<string> {
  if (isAbsolute(file)) return ok(file);
  if (filesDir && !/[\\/]/.test(file) && file !== "." && file !== "..") return ok(join(filesDir, file));
  return err(`${step} takes absolute file paths${filesDir ? ", or the name alone of a file in this chat's files" : ""}: ${file}`);
}

/** Width and height of a PNG or JPEG, from its header. */
function imageSize(image: Buffer): { width: number; height: number } | undefined {
  if (image.length > 24 && image.readUInt32BE(0) === 0x89504e47) {
    return { width: image.readUInt32BE(16), height: image.readUInt32BE(20) };
  }
  // A JPEG is a run of segments; the frame header (SOF0-SOF15, bar three other uses) has the size.
  for (let at = 2; at + 9 < image.length && image[at] === 0xff;) {
    const marker = image[at + 1];
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { width: image.readUInt16BE(at + 7), height: image.readUInt16BE(at + 5) };
    }
    at += 2 + image.readUInt16BE(at + 2);
  }
  return undefined;
}

/**
 * The `screenshot` step: `[ref] [file] [--full] [--annotate]`. The picture goes to the model
 * with the tool result; it is also kept when the step names a file.
 */
export async function takeScreenshot(
  args: readonly string[],
  timeoutMs: number | undefined,
  commandOptions: BrowserCommandOptions,
  files: BrowserStepFiles = {},
): Promise<BrowserCommandResult & { image?: BrowserStepImage }> {
  const options = args.filter((arg) => SCREENSHOT_OPTIONS.includes(arg));
  const [first, second] = args.filter((arg) => !SCREENSHOT_OPTIONS.includes(arg));
  const ref = first?.startsWith("@") ? first : undefined;
  const file = ref ? second : first;
  const kept = file === undefined ? undefined : stepFilePath("screenshot", file, files.filesDir);
  if (kept && !kept.ok) return { ok: false, output: kept.error };
  const path = kept?.value ?? join(tmpdir(), `bridge-screenshot-${randomUUID()}.jpg`);
  const png = extname(path).toLowerCase() === ".png";
  try {
    if (kept) await mkdir(dirname(path), { recursive: true });
    const result = await (files.runCommand ?? ab)([
      "screenshot", ...(ref ? [ref] : []), path, ...options,
      "--screenshot-format", png ? "png" : "jpeg", ...(png ? [] : ["--screenshot-quality", "70"]),
    ], timeoutMs, { ...commandOptions, skipRecovery: true });
    if (!result.ok) return result;
    const image = await readFile(path);
    const size = imageSize(image);
    if (image.length > MAX_SCREENSHOT_BYTES || !size || Math.max(size.width, size.height) > MAX_SCREENSHOT_SIDE) {
      const tooLarge = `too large to show (${size ? `${size.width}x${size.height}, ` : ""}${image.length} bytes)`;
      return kept
        ? { ok: true, output: `Screenshot saved to ${path}, but ${tooLarge}.` }
        : { ok: false, output: `The screenshot is ${tooLarge}. Take the visible page without --full, or one element.` };
    }
    const labels = Array.isArray(result.data?.annotations)
      ? (result.data.annotations as Array<{ ref?: unknown; role?: unknown; name?: unknown }>)
        .map((label) => `\n@${String(label.ref)} ${String(label.role)} ${JSON.stringify(label.name ?? "")}`).join("")
      : "";
    return {
      ok: true,
      output: `Screenshot attached (${size.width}x${size.height})${kept ? `, saved to ${path}` : ""}.${labels}`,
      image: { data: image.toString("base64"), mimeType: png ? "image/png" : "image/jpeg" },
    };
  } catch (error) {
    return { ok: false, output: `screenshot failed: ${error instanceof Error ? error.message : String(error)}` };
  } finally {
    if (!kept) await rm(path, { force: true }).catch(() => {});
  }
}

/** The `download` step: `<ref> <file>`. Clicks the element and saves what it downloads. */
export async function saveDownload(
  args: readonly string[],
  timeoutMs: number | undefined,
  commandOptions: BrowserCommandOptions,
  files: BrowserStepFiles = {},
): Promise<BrowserCommandResult> {
  const path = stepFilePath("download", args[1], files.filesDir);
  if (!path.ok) return { ok: false, output: path.error };
  try {
    await mkdir(dirname(path.value), { recursive: true });
  } catch (error) {
    return { ok: false, output: `download failed: ${error instanceof Error ? error.message : String(error)}` };
  }
  const result = await (files.runCommand ?? ab)(["download", args[0], path.value], timeoutMs, { ...commandOptions, skipRecovery: true });
  return result.ok ? { ok: true, output: `Saved the download to ${path.value}.` } : result;
}
