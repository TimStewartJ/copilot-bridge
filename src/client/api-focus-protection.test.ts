import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FocusProtectionCreateRequest, FocusProtectionPage } from "./api";
import { FOCUS_TEST_NOW_MS } from "./test-focus-fixtures";
import { protectionImpact, protectionPreview, protectionRequest, protectionSnapshot, protectionWindow } from "./test-focus-protection-fixtures";

type RecordedRequest = { url: string; method: string; body?: unknown };
let api: typeof import("./api");

function responses(...values: Response[]) {
  const requests: RecordedRequest[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/api/telemetry/batch")) return Response.json({});
    requests.push({ url, method: init?.method ?? "GET", ...(typeof init?.body === "string" ? { body: JSON.parse(init.body) } : {}) });
    const result = values.shift();
    if (!result) throw new Error(`Unexpected request: ${url}`);
    return result;
  }));
  return requests;
}

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(FOCUS_TEST_NOW_MS);
  vi.stubEnv("BASE_URL", "/");
  responses();
  api = await import("./api");
});
afterEach(async () => {
  try { await vi.runOnlyPendingTimersAsync(); }
  finally {
    vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); vi.resetModules();
  }
});

describe("typed Focus protection API", () => {
  it("retains server current/upcoming/latest state and aggregate plus recent impacts", async () => {
    const current = protectionWindow();
    const upcoming = protectionWindow({ id: "future-window", status: "scheduled", startsAt: "2026-09-06T18:00:00.000Z", endsAt: "2026-09-06T19:00:00.000Z" });
    const snapshot = protectionSnapshot({
      current, upcoming, latest: current,
      impacts: { postponed: 54, pending: 8, dispositions: { started: 41, expired: 5 }, recent: [protectionImpact()] },
    });
    const page: FocusProtectionPage = { generatedAt: snapshot.generatedAt, windows: [upcoming, current], nextOffset: 52 };
    const requests = responses(Response.json(snapshot), Response.json(page), Response.json({ ...page, nextOffset: null }));
    await expect(api.fetchFocusProtectionCurrent()).resolves.toEqual(snapshot);
    await expect(api.fetchFocusProtectionPage()).resolves.toEqual(page);
    await expect(api.fetchFocusProtectionPage(52, 20)).resolves.toEqual({ ...page, nextOffset: null });
    expect(requests).toEqual([
      { url: "/api/focus/protection/current", method: "GET" },
      { url: "/api/focus/protection?offset=0&limit=50", method: "GET" },
      { url: "/api/focus/protection?offset=52&limit=20", method: "GET" },
    ]);
  });

  it.each([false, true])("posts an exact preview and confirmation, scheduled=%s", async (scheduled) => {
    const input = protectionRequest({ ...(scheduled ? { startsAt: "2026-09-05T18:10:00.000Z" } : {}), allowAuthorizedDeadlineOverride: true });
    const preview = protectionPreview({ request: input });
    const create: FocusProtectionCreateRequest = { ...preview.request, confirmationToken: preview.confirmationToken, confirmInterventionConflicts: true };
    const window = protectionWindow({ ...input, status: scheduled ? "scheduled" : "active" });
    const requests = responses(Response.json(preview), Response.json({ window }));
    await expect(api.previewFocusProtection(input)).resolves.toEqual(preview);
    await expect(api.createFocusProtection(create)).resolves.toEqual(window);
    expect(requests).toEqual([
      { url: "/api/focus/protection/preview", method: "POST", body: input },
      { url: "/api/focus/protection", method: "POST", body: create },
    ]);
    if (!scheduled) expect(requests[0].body).not.toHaveProperty("startsAt");
    expect(vi.mocked(fetch).mock.calls[1]?.[1]?.headers).toEqual({ "Content-Type": "application/json" });
  });

  it("preserves false bypass/conflict flags instead of supplying implicit authority", async () => {
    const input: FocusProtectionCreateRequest = {
      ...protectionRequest({ allowNeedsInput: false, allowAuthorizedDeadlineOverride: false }),
      confirmationToken: "explicitly-reviewed", confirmInterventionConflicts: false,
    };
    const requests = responses(Response.json({ window: protectionWindow(input) }));
    await api.createFocusProtection(input);
    expect(requests[0].body).toEqual(input);
  });

  it("encodes cancellation identity and sends an explicit empty POST body", async () => {
    const id = "window /?#";
    const window = protectionWindow({ id, status: "cancelled", cancelledAt: "2026-09-05T18:10:00.000Z" });
    const requests = responses(Response.json({ window }));
    await expect(api.cancelFocusProtection(id)).resolves.toEqual(window);
    expect(requests).toEqual([{ url: `/api/focus/protection/${encodeURIComponent(id)}/cancel`, method: "POST", body: {} }]);
  });

  it("keeps preview conflict status/details and does not silently refresh or retry a write", async () => {
    const details = { code: "preview_changed", requiresPreview: true };
    const requests = responses(Response.json({ error: "Impact fingerprint changed", details }, { status: 409 }));
    await expect(api.createFocusProtection({
      ...protectionRequest(), confirmationToken: "old", confirmInterventionConflicts: true,
    })).rejects.toMatchObject({ name: "ApiError", status: 409, message: "Impact fingerprint changed", details });
    expect(requests).toHaveLength(1);
  });

  it("rejects unavailable current data instead of returning an inactive or zero-impact snapshot", async () => {
    responses(Response.json({ error: "Protection storage unavailable" }, { status: 503 }));
    await expect(api.fetchFocusProtectionCurrent()).rejects.toMatchObject({ status: 503, message: "Protection storage unavailable" });
  });

  it("uses the staging API base for preview requests", async () => {
    vi.resetModules();
    vi.stubEnv("BASE_URL", "/staging/protected/");
    api = await import("./api");
    const preview = protectionPreview();
    const requests = responses(Response.json(preview));
    await api.previewFocusProtection(preview.request);
    expect(requests[0].url).toBe("/staging/protected/api/focus/protection/preview");
  });
});
