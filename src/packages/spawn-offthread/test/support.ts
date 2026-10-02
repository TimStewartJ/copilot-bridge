import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

const created: string[] = [];

/** A fresh temporary directory, removed when the test file that asked for it finishes. */
export function makeTempDir(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `spawn-offthread-${label}-`));
  created.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});
