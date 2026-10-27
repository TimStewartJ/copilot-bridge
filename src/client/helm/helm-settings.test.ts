import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createReactDomHarness, waitUntilAct } from "../test-react-harness";
import { HELM_SETTINGS_DEFAULTS } from "../../shared/helm-settings";
import { patchHelmSettings, refreshHelmSettings, useHelmPreferences } from "./helm-settings";

afterEach(() => vi.unstubAllGlobals());

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe("unified Helm browser persistence", () => {
  it("shows the server's settings and saves flat patches without overwriting other fields", async () => {
    let stored = { ...HELM_SETTINGS_DEFAULTS, voice: "bm_george", patience: 0.9 };
    const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      if (init?.method === "PATCH") stored = { ...stored, ...JSON.parse(String(init.body)) };
      return response({ schemaVersion: 1, settings: stored });
    });
    vi.stubGlobal("fetch", fetch);
    const harness = await createReactDomHarness();
    let preferences: ReturnType<typeof useHelmPreferences>;
    function Probe() { preferences = useHelmPreferences(); return null; }
    await harness.render(createElement(Probe));
    await waitUntilAct(harness.act, () => preferences.data?.settings.voice === "bm_george");
    await harness.act(async () => { await patchHelmSettings({ glossary: "Tether = my iPhone app" }); });
    await waitUntilAct(harness.act, () => preferences.data?.settings.glossary === "Tether = my iPhone app");
    const patch = fetch.mock.calls.find(([, init]) => init?.method === "PATCH")!;
    expect(JSON.parse(String(patch[1]!.body))).toEqual({ glossary: "Tether = my iPhone app" });
    expect(stored).toMatchObject({ voice: "bm_george", patience: 0.9 });
    fetch.mockImplementationOnce(async () => response({ error: "Read-only settings" }, 400));
    await harness.act(async () => { await patchHelmSettings({ glossary: "x" }).catch(() => undefined); });
    await waitUntilAct(harness.act, () => preferences.error === "Read-only settings");
    expect(preferences!.data?.settings.glossary).toBe("Tether = my iPhone app");
  });

  it("serializes writes and refreshes and rejects an older instance", async () => {
    let stored = { ...HELM_SETTINGS_DEFAULTS };
    const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      if (init?.method === "PATCH") stored = { ...stored, ...JSON.parse(String(init.body)) };
      return response({ schemaVersion: 1, settings: stored });
    });
    vi.stubGlobal("fetch", fetch);
    await Promise.all([
      patchHelmSettings({ echoSafe: false }),
      refreshHelmSettings(),
      patchHelmSettings({ transport: "http" }),
    ]);
    expect(stored).toMatchObject({ echoSafe: false, transport: "http" });
    expect(fetch.mock.calls.map(([, init]) => init?.method ?? "GET")).toEqual(["PATCH", "GET", "PATCH"]);
    fetch.mockImplementationOnce(async () => response({ settings: stored }));
    await expect(refreshHelmSettings()).rejects.toThrow("does not support unified Helm settings");
  });
});
