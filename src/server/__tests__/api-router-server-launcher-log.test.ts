import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import type { Express } from "express";
import { createTestApp } from "./helpers.js";

let app: Express;
let tempDir: string;
let launcherLogPath: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "bridge-launcher-route-"));
  launcherLogPath = join(tempDir, "launcher.log");
  ({ app } = createTestApp({ launcherLogPath }));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("launcher log route", () => {
  it("GET /api/server/launcher-log returns the requested tail", async () => {
    writeFileSync(
      launcherLogPath,
      [
        "[10:00:00.000] [launcher] first",
        "[10:00:01.000] [launcher] second",
        "[10:00:02.000] [launcher] third",
      ].join("\n"),
      "utf-8",
    );

    const res = await request(app).get("/api/server/launcher-log?lines=2");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      status: "ok",
      lines: [
        "[10:00:01.000] [launcher] second",
        "[10:00:02.000] [launcher] third",
      ],
    });
  });

  it("GET /api/server/launcher-log reports when the log is unavailable", async () => {
    const res = await request(app).get("/api/server/launcher-log");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      status: "unavailable",
      error: "Launcher log is not available yet. Restart the bridge through the launcher to populate it.",
    });
  });

  it("GET /api/server/launcher-log reports unavailable when the server was not started by the launcher", async () => {
    const res = await request(createTestApp().app).get("/api/server/launcher-log");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      status: "unavailable",
      error: "Launcher log is unavailable because this server was not started by the launcher.",
    });
  });

  it("GET /api/server/launcher-log reports unavailable in staging", async () => {
    const res = await request(createTestApp({ launcherLogPath, isStaging: true }).app).get("/api/server/launcher-log");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      status: "unavailable",
      error: "Launcher log is unavailable in staging previews.",
    });
  });
});
