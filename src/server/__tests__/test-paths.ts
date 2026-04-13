// Cross-platform test utilities — no node:fs imports so this file
// is safe to use alongside vi.mock("node:fs") in browser tests.

import { join } from "node:path";
import { platform, tmpdir } from "node:os";

/** True when running on Windows */
export const isWindows = platform() === "win32";

/** Platform-safe fake copilotHome for tests that don't touch the real filesystem */
export function testCopilotHome(): string {
  return join(tmpdir(), "test-copilot");
}

/** Normalize path separators to forward slashes for cross-platform assertions */
export function normalizePath(p: string): string {
  return p.replaceAll("\\", "/");
}
