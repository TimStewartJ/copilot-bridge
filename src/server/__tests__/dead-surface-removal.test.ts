import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ApiRouteTestState } from "./api-routes-test-helpers.js";
import { installApiRouteTestHooks, request } from "./api-routes-test-helpers.js";
import { createTelemetryStore } from "../telemetry-store.js";
import { createDocsIndex } from "../docs-index.js";
import { createDocsStore } from "../docs-store.js";
import * as releaseSlots from "../release-slots.js";
import { setupTestDb, makeTestDir } from "./helpers.js";

let app: ApiRouteTestState["app"];
let ctx: ApiRouteTestState["ctx"];

installApiRouteTestHooks((state) => {
  ({ app, ctx } = state);
});

describe("removed API surface returns 404", () => {
  it("no longer exposes telemetry read-back routes", async () => {
    expect(ctx.telemetryStore).toBeDefined();
    for (const [method, path] of [
      ["get", "/api/telemetry"],
      ["get", "/api/telemetry/stats"],
      ["delete", "/api/telemetry"],
    ] as const) {
      const res = await (request(app) as any)[method](path);
      expect(res.status, `${method.toUpperCase()} ${path}`).toBe(404);
    }
  });

  it("still accepts telemetry ingestion", async () => {
    const single = await request(app)
      .post("/api/telemetry")
      .send({ name: "client.render", duration: 12 });
    expect(single.status).toBe(200);

    const batch = await request(app)
      .post("/api/telemetry/batch")
      .send({ spans: [{ name: "client.route", duration: 5 }] });
    expect(batch.status).toBe(200);

    expect(ctx.telemetryStore!.querySpans({ source: "client" }).length).toBeGreaterThan(0);
  });

  it("no longer exposes the orphaned session-overlay-reaper maintenance route", async () => {
    const res = await request(app)
      .post("/api/maintenance/session-overlay-reaper")
      .send({ dryRun: true });
    expect(res.status).toBe(404);
  });
});

describe("dead exports are gone", () => {
  it("removes dead client API helpers", () => {
    const source = readFileSync(join(process.cwd(), "src", "client", "api.ts"), "utf-8");
    for (const removed of [
      "export async function updateTask(",
      "export async function fetchTelemetryStats(",
      "export async function removeTagMcpServer(",
      "export async function removeTagMcpServerRef(",
      "export async function addTagMcpServerRef(",
      "_method",
      "export interface DashboardData",
      "export interface DashboardTaskMomentum",
      "pricingSource",
    ]) {
      expect(source, removed).not.toContain(removed);
    }
    for (const kept of [
      "export async function patchTask(",
      "export async function fetchDashboard(",
      "export async function setTagMcpServerRefs(",
      "export interface DashboardChecklistData",
      "pricingStatus",
    ]) {
      expect(source, kept).toContain(kept);
    }
  });

  it("removes telemetryStore.getStats but keeps querySpans and pruneOldSpans", () => {
    const store = createTelemetryStore(setupTestDb());
    expect("getStats" in store).toBe(false);
    expect(typeof store.querySpans).toBe("function");
    expect(typeof store.pruneOldSpans).toBe("function");
  });

  it("removes the unreachable docs folder-delete functions", () => {
    const db = setupTestDb();
    const docsStore = createDocsStore(makeTestDir("docs-dead-surface"));
    const docsIndex = createDocsIndex(db, docsStore);
    expect("deleteFolder" in docsStore).toBe(false);
    expect("removeFolder" in docsIndex).toBe(false);
    // Page and DB-entry deletion stay intact.
    expect(typeof docsStore.deletePage).toBe("function");
    expect(typeof docsStore.deleteDbEntry).toBe("function");
    expect(typeof docsIndex.removePage).toBe("function");
  });

  it("removes the dead synchronous active-release writer", () => {
    expect("writeActiveReleaseSync" in releaseSlots).toBe(false);
    expect(typeof releaseSlots.writeActiveRelease).toBe("function");
  });

  it("removes the dead SessionManager SDK session-list cache", () => {
    const source = readFileSync(join(process.cwd(), "src", "server", "session-manager.ts"), "utf-8");
    expect(source).not.toContain("sessionListCache");
    expect(source).not.toContain("SESSION_LIST_TTL");
    expect(source).not.toContain("getSessionMetadata(sessionId: string)");
    // Disk listing and its invalidation are untouched.
    expect(source).toContain("invalidateSessionListCache");
    expect(source).toContain("listSessionsFromDisk");
  });
});

describe("build no longer pays the release-slot postbuild delay", () => {
  it("drops the delay script from the npm lifecycle", () => {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf-8")) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts.postbuild).toBe("tsx src/server/build-stamp.ts write");
    for (const command of Object.values(pkg.scripts)) {
      expect(command).not.toContain("release-slot-postbuild-delay");
    }
  });
});
