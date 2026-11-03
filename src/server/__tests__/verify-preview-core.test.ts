import { describe, expect, it } from "vitest";
import { buildVerifyPreviewSummary, parseVerifyPreviewArgs } from "../verify-preview-core.js";

describe("parseVerifyPreviewArgs", () => {
  it("normalizes the preview URL and derives its API base", () => {
    const parsed = parseVerifyPreviewArgs([
      "--url", "https://bridge.example.devtunnels.ms/staging/abc123?x=1#top",
      "--out", "shots",
      "--chat",
      "--model", "example-model",
    ]);
    expect(parsed).toEqual({
      ok: true,
      options: {
        baseUrl: "https://bridge.example.devtunnels.ms/staging/abc123/",
        apiBase: "https://bridge.example.devtunnels.ms/staging/abc123/api",
        outDir: "shots",
        screens: true,
        requireScreens: false,
        chat: true,
        model: "example-model",
        readOnly: false,
      },
    });
  });

  it.each([
    [[], "--url is required"],
    [["--url"], "--url needs a value"],
    [["--url", "--chat"], "--url needs a value"],
    [["--url", "ftp://127.0.0.1/"], "--url must be an http or https URL"],
    [["--url", "not a url"], "--url is not a valid URL: not a url"],
    [["--url", "http://127.0.0.1:9", "--bogus"], "Unknown argument: --bogus"],
    [["--url", "http://127.0.0.1:9", "--no-screens", "--require-screens"], "--no-screens and --require-screens cannot be combined"],
    [["--url", "http://127.0.0.1:9", "--chat", "--read-only"], "--chat creates a session, so it cannot be combined with --read-only"],
    [["--url", "http://127.0.0.1:9", "--model", "example-model"], "--model only applies with --chat"],
  ])("rejects %j", (argv, error) => {
    expect(parseVerifyPreviewArgs(argv)).toEqual({ ok: false, error });
  });
});

describe("buildVerifyPreviewSummary", () => {
  it("fails on any failed check, and when nothing passed", () => {
    const base = {
      options: { baseUrl: "http://127.0.0.1:9/", apiBase: "http://127.0.0.1:9/api" },
      outDir: "out",
      startedAt: new Date(0),
      finishedAt: new Date(1),
      screenshots: [],
    };
    const pass = { name: "health", status: "pass" as const, durationMs: 1 };
    const skip = { name: "screenshots", status: "skip" as const, durationMs: 0 };
    const fail = { name: "settings read", status: "fail" as const, durationMs: 1 };

    expect(buildVerifyPreviewSummary({ ...base, checks: [pass, skip] })).toMatchObject({
      ok: true,
      counts: { pass: 1, fail: 0, skip: 1 },
    });
    expect(buildVerifyPreviewSummary({ ...base, checks: [pass, fail] }).ok).toBe(false);
    expect(buildVerifyPreviewSummary({ ...base, checks: [skip] }).ok).toBe(false);
  });
});
