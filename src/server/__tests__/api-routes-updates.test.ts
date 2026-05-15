import { afterEach, describe, expect, it, vi } from "vitest";
import { request } from "./api-routes-test-helpers.js";
import { createTestApp, makeTestRuntimePaths } from "./helpers.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("Update routes", () => {
  it("GET /api/updates/check reports disabled outside release mode", async () => {
    const local = createTestApp({
      runtimePaths: makeTestRuntimePaths("api-updates-dev", { distributionMode: "development" }),
    });

    const res = await request(local.app).get("/api/updates/check");

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("disabled");
    expect(res.body.enabled).toBe(false);
  });

  it("GET /api/updates/check validates channel", async () => {
    const local = createTestApp();

    const res = await request(local.app).get("/api/updates/check?channel=nightly");

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Unsupported update channel");
  });

  it("POST /api/updates/install rejects cross-site requests", async () => {
    const local = createTestApp();

    const res = await request(local.app)
      .post("/api/updates/install")
      .set("Host", "localhost:3333")
      .set("Origin", "https://evil.example.test")
      .send({ channel: "stable" });

    expect(res.status).toBe(403);
  });

  it("POST /api/updates/install accepts same-origin staging proxy headers", async () => {
    vi.stubEnv("BRIDGE_STAGING_PREVIEW", "true");
    const local = createTestApp({
      runtimePaths: makeTestRuntimePaths("api-updates-install-staging-proxy", { distributionMode: "development" }),
    });

    const res = await request(local.app)
      .post("/api/updates/install")
      .set("Host", "127.0.0.1:49152")
      .set("X-Forwarded-Host", "preview.example.test")
      .set("Origin", "https://preview.example.test")
      .send({ channel: "stable" });

    expect(res.status).toBe(409);
    expect(res.body.error).toContain("packaged release mode");
  });

  it("POST /api/updates/install accepts staging UI fetch metadata when the child host is local", async () => {
    vi.stubEnv("BRIDGE_STAGING_PREVIEW", "true");
    const local = createTestApp({
      runtimePaths: makeTestRuntimePaths("api-updates-install-staging-fetch-site", { distributionMode: "development" }),
    });

    const res = await request(local.app)
      .post("/api/updates/install")
      .set("Host", "127.0.0.1:49152")
      .set("Origin", "https://preview.example.test")
      .set("Sec-Fetch-Site", "same-origin")
      .send({ channel: "stable" });

    expect(res.status).toBe(409);
    expect(res.body.error).toContain("packaged release mode");
  });

  it("POST /api/updates/install is disabled outside release mode", async () => {
    const local = createTestApp({
      runtimePaths: makeTestRuntimePaths("api-updates-install-dev", { distributionMode: "development" }),
    });

    const res = await request(local.app)
      .post("/api/updates/install")
      .send({ channel: "stable" });

    expect(res.status).toBe(409);
    expect(res.body.error).toContain("packaged release mode");
  });
});
