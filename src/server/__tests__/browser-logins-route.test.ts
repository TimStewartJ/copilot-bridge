import { describe, expect, it, vi } from "vitest";

import { getBrowserRuntime } from "../browser-runtime.js";
import type { BrowserLogin } from "../browser-logins.js";
import { createTestApp } from "./test-app.js";
import request from "./test-http.js";

const LOGIN: BrowserLogin = { id: "bridge-12345678-0123456789abcdef", origin: "https://accounts.example.com", username: "tim@example.com", savedAt: "2026-10-07T00:00:00.000Z" };

/** An app whose saved logins are `logins`, with the browser and the vault stood in for. */
function appWithLogins(logins: BrowserLogin[]) {
  const { app, ctx } = createTestApp();
  const runtime = getBrowserRuntime(ctx);
  vi.spyOn(runtime.logins, "list").mockResolvedValue(logins);
  const remove = vi.spyOn(runtime.logins, "remove").mockImplementation(async (id) => logins.some((login) => login.id === id));
  return { app, runtime, remove };
}

describe("saved browser logins API", () => {
  it("lists the logins by site, without anything that signs in", async () => {
    const { app } = appWithLogins([LOGIN, { ...LOGIN, id: `${LOGIN.id}2`, origin: "http://localhost:8080", failedAt: "2026-10-07T01:00:00.000Z" }]);

    const response = await request(app).get("/api/browser/logins").expect(200);

    expect(response.body).toEqual({
      logins: [
        { id: LOGIN.id, host: "accounts.example.com", username: "tim@example.com", savedAt: LOGIN.savedAt },
        { id: `${LOGIN.id}2`, host: "localhost:8080", username: "tim@example.com", savedAt: LOGIN.savedAt, failed: true },
      ],
    });
  });

  it("removes a login under the signed-in browser's name, without taking that browser", async () => {
    const { app, runtime, remove } = appWithLogins([LOGIN]);
    const withTarget = vi.spyOn(runtime.broker, "withTarget");

    await request(app).delete(`/api/browser/logins/${LOGIN.id}`).expect(200, { ok: true });

    expect(remove).toHaveBeenCalledWith(LOGIN.id, expect.objectContaining({ browserTarget: runtime.broker.getAuthenticatedTarget() }));
    expect(withTarget).not.toHaveBeenCalled();
  });

  it("answers 404 for a login that is not saved, and refuses a request from another site", async () => {
    const { app, remove } = appWithLogins([LOGIN]);

    await request(app).delete("/api/browser/logins/bridge-someone-elses").expect(404);
    remove.mockClear();
    await request(app).delete(`/api/browser/logins/${LOGIN.id}`).set("Origin", "https://evil.example").set("Sec-Fetch-Site", "cross-site").expect(403);
    expect(remove).not.toHaveBeenCalled();
  });
});
