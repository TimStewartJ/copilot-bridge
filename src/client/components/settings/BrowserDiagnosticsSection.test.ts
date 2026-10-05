import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createReactDomHarness,
  findAllByTag,
  getReactProps,
  waitUntilAct,
  type ReactDomHarness,
} from "../../test-react-harness";
import type { BrowserDiagnosticsResponse } from "../../api";
import { BrowserDiagnosticsSection } from "./BrowserDiagnosticsSection";

const apiMocks = vi.hoisted(() => ({
  checkAdoBrowserAuthentication: vi.fn(),
  closeHeadedDiagnosticsBrowser: vi.fn(),
  fetchBrowserDiagnostics: vi.fn(),
  launchHeadedDiagnosticsBrowser: vi.fn(),
  probeBrowserContext: vi.fn(),
  resetPublicBrowserData: vi.fn(),
}));

vi.mock("../../api", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../api")>(),
  ...apiMocks,
}));

type Diagnostics = BrowserDiagnosticsResponse;

function diagnostics(overrides: {
  config?: Partial<Diagnostics["config"]>;
  public?: Partial<Diagnostics["contexts"]["public"]>;
} = {}): Diagnostics {
  const base = baseDiagnostics();
  return {
    ...base,
    config: { ...base.config, ...overrides.config },
    contexts: { ...base.contexts, public: { ...base.contexts.public, ...overrides.public } },
  };
}

function baseDiagnostics(): Diagnostics {
  return {
    schemaVersion: 3 as const,
    checkedAt: "2026-09-08T16:00:00.000Z",
    windowHours: 24,
    summary: {
      tone: "warning" as const,
      label: "Functional check required",
      detail: "Browser contexts have not been checked.",
    },
    agentBrowserInstalled: true,
    config: {
      sessionName: "copilot-bridge-test",
      executablePathSource: "system" as const,
      executablePathConfigured: false,
      masterProfileDirectory: "C:\\Bridge\\authenticated",
      masterProfileDirectoryConfigured: true,
      masterProfileDirectoryExists: true,
      headed: true,
      browser: { kind: "chrome" as const, version: "Google Chrome 154.0.8037.97", installedDaysAgo: 12 },
      launch: {
        args: ["--no-first-run", "--disable-blink-features=AutomationControlled"],
        inheritedFrom: "environment" as const,
      },
      agentBrowserVersion: "0.31.2",
    },
    runtime: {
      agentBrowserInstalled: true,
      transport: {
        kind: "cli" as const,
        state: "stopped" as const,
        namespace: "copilot-bridge",
      },
    },
    contexts: {
      public: {
        context: "public" as const,
        state: "stopped" as const,
        activeOperations: 0,
        queueDepth: 0,
        functionalProbe: { state: "not_run" as const },
        profileRoot: "C:\\Bridge\\browser-public",
        profiles: 3,
        profilesInUse: 1,
        concurrencyLimit: 5,
      },
      authenticated: {
        context: "authenticated" as const,
        state: "ready" as const,
        activeOperations: 0,
        queueDepth: 0,
        functionalProbe: {
          state: "passed" as const,
          checkedAt: "2026-09-08T15:59:00.000Z",
        },
        profilePath: "C:\\Bridge\\authenticated",
        profileExists: true,
        headed: true,
        serviceChecks: [{
          service: "ado" as const,
          state: "verified" as const,
          checkedAt: "2026-09-08T15:59:30.000Z",
        }],
      },
    },
    issues: [],
  };
}

function findButton(root: any, text: string): any {
  const button = findAllByTag(root, "BUTTON")
    .find((candidate) => candidate.textContent?.trim() === text);
  if (!button) throw new Error(`Button not found: ${text}`);
  return button;
}

async function clickButton(harness: ReactDomHarness, text: string): Promise<void> {
  const button = findButton(harness.dom.container, text);
  await harness.act(async () => {
    await getReactProps(button)?.onClick?.();
  });
}

beforeEach(() => {
  apiMocks.fetchBrowserDiagnostics.mockReset();
  apiMocks.fetchBrowserDiagnostics.mockResolvedValue(diagnostics());
  apiMocks.probeBrowserContext.mockReset();
  apiMocks.probeBrowserContext.mockResolvedValue({
    ok: true,
    context: "public",
    state: "ready",
  });
  apiMocks.checkAdoBrowserAuthentication.mockReset();
  apiMocks.checkAdoBrowserAuthentication.mockResolvedValue({
    service: "ado",
    state: "verified",
    checkedAt: "2026-09-08T16:00:00.000Z",
    message: "Azure DevOps authentication verified.",
  });
  apiMocks.launchHeadedDiagnosticsBrowser.mockReset();
  apiMocks.closeHeadedDiagnosticsBrowser.mockReset();
  apiMocks.resetPublicBrowserData.mockReset();
  apiMocks.resetPublicBrowserData.mockResolvedValue({ ok: true, cleared: 2, inUse: 1 });
});

async function renderSection(): Promise<ReactDomHarness> {
  const harness = await createReactDomHarness();
  await harness.render(createElement(BrowserDiagnosticsSection, {
    draft: { mcpServers: {} },
    setDraft: vi.fn(),
  }));
  await waitUntilAct(harness.act, () =>
    (harness.dom.container.textContent ?? "").includes("Checked "),
  );
  return harness;
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("BrowserDiagnosticsSection", () => {
  it("renders public and authenticated browser contexts", async () => {
    const harness = await createReactDomHarness();
    try {
      await harness.render(createElement(BrowserDiagnosticsSection, {
        draft: { mcpServers: {}, browser: { headed: true } },
        setDraft: vi.fn(),
      }));
      await waitUntilAct(harness.act, () =>
        (harness.dom.container.textContent ?? "").includes("Public browser"),
      );

      const text = harness.dom.container.textContent ?? "";
      expect(text).toContain("Public browser");
      expect(text).toContain("Authenticated browser");
      expect(text).toContain("copilot-bridge");
      expect(text).toContain("ADO: verified");
      expect(text).toContain("Run browsers with a window");
    } finally {
      await harness.cleanup();
    }
  });

  it("says which browser runs, where it comes from and how old it is", async () => {
    const harness = await renderSection();
    const text = harness.dom.container.textContent ?? "";
    expect(text).toContain("Google Chrome 154.0.8037.97 · found on this machine · updated 12 days ago");
    expect(text).not.toContain("Sites can tell this build");
    expect(text).not.toContain("has not been updated");
    expect(text).toContain("installed · 0.31.2");
  });

  it("warns about a build that sites recognise as automation", async () => {
    for (const kind of ["chrome-for-testing", "chromium"] as const) {
      apiMocks.fetchBrowserDiagnostics.mockResolvedValue(diagnostics({
        config: {
          executablePathSource: "auto-detect",
          browser: { kind, version: "Google Chrome for Testing 149.0.7000.3", installedDaysAgo: 0 },
        },
      }));
      const harness = await renderSection();
      const text = harness.dom.container.textContent ?? "";
      expect(text).toContain(`${kind === "chromium" ? "Chromium" : "Chrome for Testing"} 149.0.7000.3 · chosen by agent-browser · updated today`);
      expect(text).toContain("Sites can tell this build from regular Chrome. Install Google Chrome for fewer blocks.");
      await harness.cleanup();
    }
  });

  it("warns about a browser that has not been updated for more than 60 days", async () => {
    apiMocks.fetchBrowserDiagnostics.mockResolvedValue(diagnostics({
      config: { browser: { kind: "chrome", version: "Google Chrome 140.0.1.2", installedDaysAgo: 61 } },
    }));
    const stale = await renderSection();
    expect(stale.dom.container.textContent).toContain(
      "This browser has not been updated for 61 days; sites distrust old versions.",
    );
    await stale.cleanup();

    apiMocks.fetchBrowserDiagnostics.mockResolvedValue(diagnostics({
      config: { browser: { kind: "chrome", version: "Google Chrome 140.0.1.2", installedDaysAgo: 60 } },
    }));
    const recent = await renderSection();
    expect(recent.dom.container.textContent).not.toContain("has not been updated");
  });

  it("copes with a browser it knows little about", async () => {
    apiMocks.fetchBrowserDiagnostics.mockResolvedValue(diagnostics({
      config: { executablePathSource: "settings", browser: { kind: "unknown" }, agentBrowserVersion: undefined },
    }));
    const harness = await renderSection();
    const text = harness.dom.container.textContent ?? "";
    expect(text).toContain("Unknown browser · set in Settings");
    expect(text).not.toContain("updated");
    expect(text).not.toContain("installed ·");
  });

  it("lists the launch arguments and says where the inherited ones come from", async () => {
    const harness = await renderSection();
    let text = harness.dom.container.textContent ?? "";
    expect(text).toContain("2 arguments");
    expect(text).toContain("--no-first-run");
    expect(text).toContain("--disable-blink-features=AutomationControlled");
    expect(text).toContain("Arguments other than the Bridge's own come from the environment.");
    await harness.cleanup();

    apiMocks.fetchBrowserDiagnostics.mockResolvedValue(diagnostics({
      config: { launch: { args: ["--no-first-run"], inheritedFrom: "agent-browser-config" } },
    }));
    const fromConfig = await renderSection();
    text = fromConfig.dom.container.textContent ?? "";
    expect(text).toContain("1 argument");
    expect(text).toContain("come from agent-browser's config file.");
    await fromConfig.cleanup();

    apiMocks.fetchBrowserDiagnostics.mockResolvedValue(diagnostics({
      config: { launch: { args: [], inheritedFrom: "none" } },
    }));
    const none = await renderSection();
    expect(none.dom.container.textContent).toContain("Only the Bridge's own arguments are used.");
  });

  it.each([
    { name: "has not been checked", liveView: undefined, badge: "Not checked yet", notice: undefined },
    { name: "works", liveView: { ok: true, checkedAt: "2026-09-08T15:58:00.000Z" }, badge: "Working", notice: undefined },
    {
      name: "does not work",
      liveView: { ok: false, checkedAt: "2026-09-08T15:58:00.000Z", message: "The stream sent no picture of the page." },
      badge: "Not working",
      notice: "The stream sent no picture of the page.",
    },
    {
      name: "does not work for a reason nobody gave",
      liveView: { ok: false, checkedAt: "2026-09-08T15:58:00.000Z" },
      badge: "Not working",
      notice: "The browser could not be shown.",
    },
  ])("says that the live view $name", async ({ liveView, badge, notice }) => {
    apiMocks.fetchBrowserDiagnostics.mockResolvedValue(diagnostics({ config: { liveView } }));
    const harness = await renderSection();
    try {
      const text = harness.dom.container.textContent ?? "";
      for (const other of ["Not checked yet", "Working", "Not working"].filter((label) => label !== badge)) {
        expect(text).not.toContain(other);
      }
      expect(text).toContain(badge);
      // Only a live view that does not work comes with what was found and how to update.
      expect(text.includes("npm install -g agent-browser@latest")).toBe(notice !== undefined);
      if (notice) expect(text).toContain(notice);
    } finally {
      await harness.cleanup();
    }
  });

  it("shows the public profiles and clears their browsing data", async () => {
    const harness = await renderSection();
    const text = harness.dom.container.textContent ?? "";
    expect(text).toContain("3 profiles, 1 in use. Public profiles keep cookies between uses.");
    expect(text).toContain("C:\\Bridge\\browser-public");
    expect(apiMocks.fetchBrowserDiagnostics).toHaveBeenCalledTimes(1);

    apiMocks.fetchBrowserDiagnostics.mockResolvedValue(diagnostics({ public: { profiles: 1, profilesInUse: 1 } }));
    await clickButton(harness, "Clear public browsing data");
    expect(apiMocks.resetPublicBrowserData).toHaveBeenCalledOnce();
    await waitUntilAct(harness.act, () =>
      (harness.dom.container.textContent ?? "").includes("1 profile, 1 in use."),
    );
    expect(harness.dom.container.textContent).toContain("Cleared 2 profiles; 1 in use was left alone.");
    expect(apiMocks.fetchBrowserDiagnostics).toHaveBeenCalledTimes(2);
  });

  it("reports a clear that left nothing behind, and one that failed", async () => {
    apiMocks.resetPublicBrowserData.mockResolvedValueOnce({ ok: true, cleared: 1, inUse: 0 });
    const harness = await renderSection();
    await clickButton(harness, "Clear public browsing data");
    await waitUntilAct(harness.act, () =>
      (harness.dom.container.textContent ?? "").includes("Cleared 1 profile."),
    );
    expect(harness.dom.container.textContent).not.toContain("left alone");

    apiMocks.resetPublicBrowserData.mockRejectedValueOnce(new Error("Public profiles are locked."));
    await clickButton(harness, "Clear public browsing data");
    await waitUntilAct(harness.act, () =>
      (harness.dom.container.textContent ?? "").includes("Public profiles are locked."),
    );
    expect(harness.dom.container.textContent).not.toContain("Cleared 1 profile.");
  });

  it("runs public readiness and Azure DevOps authentication checks", async () => {
    const harness = await createReactDomHarness();
    try {
      await harness.render(createElement(BrowserDiagnosticsSection, {
        draft: { mcpServers: {} },
        setDraft: vi.fn(),
      }));
      await waitUntilAct(harness.act, () =>
        (harness.dom.container.textContent ?? "").includes("Check public browser"),
      );

      await clickButton(harness, "Check public browser");
      expect(apiMocks.probeBrowserContext).toHaveBeenCalledWith("public");

      await clickButton(harness, "Verify ADO");
      expect(apiMocks.checkAdoBrowserAuthentication).toHaveBeenCalledOnce();
      await waitUntilAct(harness.act, () =>
        (harness.dom.container.textContent ?? "").includes("Azure DevOps authentication verified."),
      );
    } finally {
      await harness.cleanup();
    }
  });
});
