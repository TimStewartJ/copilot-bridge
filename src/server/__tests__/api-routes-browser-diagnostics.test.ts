import { describe, expect, it } from "vitest";
import { request } from "./api-routes-test-helpers.js";
import { createTestApp } from "./helpers.js";

describe("Browser diagnostics routes", () => {
  it("POST /api/browser/diagnostics/launch-headed rejects cross-site requests", async () => {
    const local = createTestApp();

    const res = await request(local.app)
      .post("/api/browser/diagnostics/launch-headed")
      .set("Host", "localhost:3333")
      .set("Origin", "https://evil.example.test")
      .send({});

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Headed browser launch must be started from the Bridge UI.");
  });

  it("POST /api/browser/diagnostics/close-headed rejects cross-site requests", async () => {
    const local = createTestApp();

    const res = await request(local.app)
      .post("/api/browser/diagnostics/close-headed")
      .set("Host", "localhost:3333")
      .set("Origin", "https://evil.example.test")
      .send({});

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Headed browser close must be started from the Bridge UI.");
  });
});
