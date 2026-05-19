import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("server startup git hash wiring", () => {
  it("reads startup short hashes from the hardened git revision helper without changing webhook text", () => {
    const source = readFileSync(join(process.cwd(), "src", "server", "index.ts"), "utf-8");

    expect(source).toMatch(/import\s+\{\s*gitHash\s*\}\s+from "\.\/git-revisions\.js";/);
    expect(source).not.toMatch(/import\s+\{[^}]*gitHash[^}]*\}\s+from "\.\/tunnel\.js";/);
    expect(source).toContain("await notifyWebhook(`🤖 Copilot Bridge is online! (${gitHash()}, PID ${process.pid})`);");
  });
});
