// Cross-platform test utilities — no node:fs imports so this file is safe
// to use from client/server tests alongside vi.mock("node:fs").

import { join, posix, win32 } from "node:path";
import { platform, tmpdir } from "node:os";

/** True when running on Windows */
export const isWindows = platform() === "win32";
export const isLinux = platform() === "linux";

/** Platform-safe fake copilotHome for tests that don't touch the real filesystem */
export function testCopilotHome(): string {
  return join(tmpdir(), "test-copilot");
}

/** Build a platform-safe test path rooted under the fake copilot home */
export function testPath(...segments: string[]): string {
  return join(testCopilotHome(), ...segments);
}

export function testPosixPath(...segments: string[]): string {
  return posix.join(posix.sep, ...segments);
}

export function testWindowsPath(...segments: string[]): string {
  return win32.join("C:\\", ...segments);
}

/** Normalize path separators to forward slashes for cross-platform assertions */
export function normalizePath(p: string): string {
  return p.replaceAll("\\", "/");
}

/** Split a path into normalized segments for portable assertions */
export function pathSegments(p: string): string[] {
  return normalizePath(p).split("/").filter(Boolean);
}

/** Read the final path segment without depending on host path semantics */
export function pathBasename(p: string): string {
  return pathSegments(p).at(-1) ?? "";
}

/** Platform-safe fake executable path for command discovery tests */
export function testExecutablePath(command: string): string {
  return join(testCopilotHome(), "bin", isWindows ? `${command}.exe` : command);
}
