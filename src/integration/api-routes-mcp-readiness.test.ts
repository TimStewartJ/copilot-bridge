import { describe, expect, it, vi } from "vitest";
import { createMockSessionManager, createTestApp, request } from "../test-support/api-routes.js";

const connected = [{ name: "demo", status: "connected" }];
const startedAt = "2026-09-15T17:00:00Z";

describe("MCP connection observations and tool readiness", () => {
  it.each(["initializing", "failed"] as const)("returns %s readiness without blocking or downgrading cached connections", async (state) => {
    const manager = createMockSessionManager();
    const readiness = { state, startedAt, ...(state === "failed" ? { error: "Tool initialization failed: permission denied" } : {}) };
    manager.getSessionToolReadiness = vi.fn().mockReturnValue(readiness);
    manager.getCachedMcpStatus = vi.fn().mockReturnValue(connected);
    manager.getMcpStatus = vi.fn().mockRejectedValue(new Error("should not probe"));
    const { app } = createTestApp({ sessionManager: manager });
    const response = await request(app).get("/api/sessions/demo/mcp-status");
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ servers: connected, toolReadiness: readiness });
    expect(manager.getMcpStatus).not.toHaveBeenCalled();
  });

  it("reports unknown readiness explicitly instead of inferring ready from an empty list", async () => {
    const manager = createMockSessionManager();
    const { app } = createTestApp({ sessionManager: manager });
    const response = await request(app).get("/api/sessions/cold/mcp-status");
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ servers: [], toolReadiness: null });
  });

  it("includes ready initialization evidence independently of an empty server list", async () => {
    const manager = createMockSessionManager();
    const readiness = { state: "ready", startedAt, completedAt: startedAt };
    manager.getSessionToolReadiness = vi.fn().mockReturnValue(readiness);
    const { app } = createTestApp({ sessionManager: manager });
    const response = await request(app).get("/api/sessions/ready/mcp-status");
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ servers: [], toolReadiness: readiness });
  });

  it("preserves an initialization failure that occurs during the status probe", async () => {
    const manager = createMockSessionManager();
    manager.getSessionToolReadiness = vi.fn().mockReturnValueOnce(undefined).mockReturnValue({ state: "failed", startedAt, error: "metadata validation failed" });
    manager.getMcpStatus = vi.fn().mockRejectedValue(new Error("metadata validation failed"));
    manager.getCachedMcpStatus = vi.fn().mockReturnValue(connected);
    const { app } = createTestApp({ sessionManager: manager });
    const response = await request(app).get("/api/sessions/failure/mcp-status");
    expect(response.status).toBe(200);
    expect(response.body.servers).toEqual(connected);
    expect(response.body.toolReadiness.error).toBe("metadata validation failed");
  });

  it("keeps real status probe errors as errors when readiness is not the cause", async () => {
    const manager = createMockSessionManager();
    manager.getMcpStatus = vi.fn().mockRejectedValue(new Error("connection closed"));
    const { app } = createTestApp({ sessionManager: manager });
    const response = await request(app).get("/api/sessions/disconnected/mcp-status");
    expect(response.status).toBe(500);
    expect(response.body.error).toContain("connection closed");
  });
});
