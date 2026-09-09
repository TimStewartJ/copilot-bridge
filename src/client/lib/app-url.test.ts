import { describe, expect, it } from "vitest";
import { getAppAbsoluteUrl } from "./app-url";

describe("getAppAbsoluteUrl", () => {
  it("preserves the deployment basename for copied routes", () => {
    expect(getAppAbsoluteUrl(
      "/sessions/session-1?message=event-1",
      "https://bridge.example",
      "/staging/1ad5e8c6",
    ).toString()).toBe(
      "https://bridge.example/staging/1ad5e8c6/sessions/session-1?message=event-1",
    );
  });
});
