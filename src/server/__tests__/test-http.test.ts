import { readdirSync, readFileSync } from "node:fs";
import type { RequestListener } from "node:http";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import request from "./test-http.js";

function collectTestFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return collectTestFiles(path);
    return entry.isFile() && entry.name.endsWith(".test.ts") ? [path] : [];
  });
}

describe("shared test HTTP transport", () => {
  it("reuses one listener and one keep-alive connection across applications", async () => {
    const createApp = (name: string): RequestListener => ((req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        name,
        url: req.url,
        localPort: req.socket.localPort,
        remotePort: req.socket.remotePort,
      }));
    });
    const firstApp = createApp("first");
    const secondApp = createApp("second");
    const responses: Array<Record<string, unknown>> = [];

    for (let index = 0; index < 20; index += 1) {
      const app = index % 2 === 0 ? firstApp : secondApp;
      const response = await request(app).get(`/value?index=${index}`);
      expect(response.status).toBe(200);
      responses.push(response.body as Record<string, unknown>);
    }

    expect(new Set(responses.map((response) => response.localPort)).size).toBe(1);
    expect(new Set(responses.map((response) => response.remotePort)).size).toBe(1);
    expect(responses[0]).toMatchObject({ name: "first", url: "/value?index=0" });
    expect(responses[1]).toMatchObject({ name: "second", url: "/value?index=1" });
  });

  it("keeps raw Supertest imports out of test files", () => {
    const testRoot = join(process.cwd(), "src");
    const offenders = collectTestFiles(testRoot)
      .filter((path) => /from\s+["']supertest["']/.test(readFileSync(path, "utf-8")))
      .map((path) => path.slice(process.cwd().length + 1).replaceAll("\\", "/"));

    expect(offenders).toEqual([]);
  });
});
